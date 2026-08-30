import { consume } from "@lit/context";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import QRCode from "qrcode";
import type { ChannelAccountSnapshot } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { renderConnectCommand } from "../../components/connect-command.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerWechatEnglish } from "../../i18n/locales/en-wechat.ts";
import { resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { loadPluginCatalog, type PluginCatalogItem } from "../../lib/plugins/index.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/wechat.css";

registerWechatEnglish();

const WEIXIN_PLUGIN_ID = "openclaw-weixin";
const WEIXIN_INSTALL_COMMAND = "npx -y @tencent-weixin/openclaw-weixin-cli install";
const WEIXIN_ENABLE_COMMAND =
  "openclaw config set plugins.entries.openclaw-weixin.enabled true && openclaw gateway restart";
const WAIT_SERVER_TIMEOUT_MS = 30_000;
const WAIT_CLIENT_TIMEOUT_MS = 45_000;
const POLL_GAP_MS = 1_000;

type AddAccountPhase = "list" | "starting" | "waiting" | "verification" | "success" | "error";

type WebLoginStartResult = {
  qrDataUrl?: string;
  message?: string;
  connected?: boolean;
  sessionKey?: string;
};

type WebLoginWaitResult = {
  connected?: boolean;
  alreadyConnected?: boolean;
  message?: string;
  qrDataUrl?: string;
  accountId?: string;
  verificationRequired?: boolean;
};

class WechatPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private plugin: PluginCatalogItem | null = null;
  @state() private pluginLoading = false;
  @state() private refreshBusy = false;
  @state() private error: string | null = null;
  @state() private addPhase: AddAccountPhase = "list";
  @state() private qrDataUrl: string | null = null;
  @state() private loginMessage: string | null = null;
  @state() private verifyCode = "";
  @state() private accountOperationId: string | null = null;

  private loginScope: GatewayConnectionScope | null = null;
  private loginSessionKey: string | null = null;
  private loginCorrelationId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
  });

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.channels,
    (channels) => {
      const handleChange = () => this.requestUpdate();
      handleChange();
      return channels.subscribe(handleChange);
    },
  );

  override disconnectedCallback() {
    this.cancelAddAccount();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private handleGatewaySnapshot(change: GatewayPageChange) {
    if (change.identityChanged || change.snapshot.phase !== "connected") {
      this.plugin = null;
      this.pluginLoading = false;
      this.refreshBusy = false;
      this.error = null;
      this.cancelAddAccount();
    }
    if (change.snapshot.phase === "connected" && change.snapshot.client) {
      void this.refresh(false);
    }
  }

  private async refresh(probe: boolean) {
    const scope = this.gateway.capture();
    if (!scope || this.refreshBusy) {
      return;
    }
    this.refreshBusy = true;
    this.pluginLoading = true;
    this.error = null;
    try {
      const [catalog] = await Promise.all([
        loadPluginCatalog(scope.client),
        this.context.channels.refresh(probe),
      ]);
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      this.plugin = catalog.plugins.find((plugin) => plugin.id === WEIXIN_PLUGIN_ID) ?? null;
    } catch (err) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(err);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.pluginLoading = false;
        this.refreshBusy = false;
      }
    }
  }

  private async startAddAccount() {
    if (this.loginScope) {
      return;
    }
    const scope = this.gateway.capture();
    if (!scope) {
      return;
    }
    this.loginScope = scope;
    this.loginCorrelationId = `webui-${crypto.randomUUID()}`;
    this.addPhase = "starting";
    this.qrDataUrl = null;
    this.loginMessage = null;
    this.verifyCode = "";
    try {
      const result = await scope.client.request<WebLoginStartResult>(
        "channels.login.start",
        {
          channel: WEIXIN_PLUGIN_ID,
          accountId: this.loginCorrelationId,
          force: true,
          timeoutMs: 30_000,
        },
        { timeoutMs: WAIT_CLIENT_TIMEOUT_MS },
      );
      if (this.loginScope !== scope) {
        return;
      }
      if (result.connected) {
        await this.finishAddAccount();
        return;
      }
      if (!result.qrDataUrl) {
        this.failAddAccount(result.message ?? t("wechatPage.loginFailed"));
        return;
      }
      this.loginSessionKey = result.sessionKey ?? this.loginCorrelationId;
      this.qrDataUrl = await QRCode.toDataURL(result.qrDataUrl, {
        margin: 2,
        width: 320,
        errorCorrectionLevel: "M",
      });
      if (this.loginScope !== scope) {
        return;
      }
      this.loginMessage = result.message
        ? formatUiExternalText(result.message)
        : t("wechatPage.scanHint");
      this.addPhase = "waiting";
      this.schedulePoll(scope);
    } catch (err) {
      if (this.loginScope === scope) {
        this.failAddAccount(formatUiError(err));
      }
    }
  }

  private schedulePoll(scope: GatewayConnectionScope) {
    this.pollTimer = setTimeout(() => void this.pollLogin(scope), POLL_GAP_MS);
  }

  private async pollLogin(scope: GatewayConnectionScope, verifyCode?: string) {
    if (this.loginScope !== scope || !this.loginSessionKey || !this.loginCorrelationId) {
      return;
    }
    try {
      const result = await scope.client.request<WebLoginWaitResult>(
        "channels.login.wait",
        {
          channel: WEIXIN_PLUGIN_ID,
          accountId: this.loginCorrelationId,
          sessionKey: this.loginSessionKey,
          timeoutMs: WAIT_SERVER_TIMEOUT_MS,
          ...(verifyCode ? { verifyCode } : {}),
        },
        { timeoutMs: WAIT_CLIENT_TIMEOUT_MS },
      );
      if (this.loginScope !== scope) {
        return;
      }
      if (result.qrDataUrl) {
        const nextQrDataUrl = await QRCode.toDataURL(result.qrDataUrl, {
          margin: 2,
          width: 320,
          errorCorrectionLevel: "M",
        });
        if (this.loginScope !== scope) {
          return;
        }
        this.qrDataUrl = nextQrDataUrl;
      }
      this.loginMessage = result.message ? formatUiExternalText(result.message) : null;
      if (result.connected || result.alreadyConnected) {
        await this.finishAddAccount();
        return;
      }
      if (result.verificationRequired) {
        this.addPhase = "verification";
        this.verifyCode = "";
        return;
      }
      this.addPhase = "waiting";
      this.schedulePoll(scope);
    } catch (err) {
      if (this.loginScope === scope) {
        this.failAddAccount(formatUiError(err));
      }
    }
  }

  private submitVerification() {
    const scope = this.loginScope;
    const code = this.verifyCode.trim();
    if (!scope || !code) {
      return;
    }
    this.addPhase = "waiting";
    void this.pollLogin(scope, code);
  }

  private async finishAddAccount() {
    this.stopLoginOperation();
    this.addPhase = "success";
    this.loginMessage = t("wechatPage.loginSuccess");
    await this.context.channels.refresh(true);
  }

  private failAddAccount(message: string) {
    this.stopLoginOperation();
    this.addPhase = "error";
    this.loginMessage = message;
  }

  private stopLoginOperation() {
    this.loginScope = null;
    this.loginSessionKey = null;
    this.loginCorrelationId = null;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private cancelAddAccount() {
    this.stopLoginOperation();
    this.addPhase = "list";
    this.qrDataUrl = null;
    this.loginMessage = null;
    this.verifyCode = "";
  }

  private async removeAccount(account: ChannelAccountSnapshot) {
    const scope = this.gateway.capture();
    if (!scope || this.accountOperationId) {
      return;
    }
    const confirmed = await showConfirmDialog({
      title: t("wechatPage.removeConfirmTitle", { account: account.name || account.accountId }),
      message: t("wechatPage.removeConfirmMessage"),
      confirmLabel: t("wechatPage.removeAccount"),
      danger: true,
    });
    if (!confirmed || !this.gateway.isCurrent(scope)) {
      return;
    }
    this.accountOperationId = account.accountId;
    try {
      await scope.client.request("channels.logout", {
        channel: WEIXIN_PLUGIN_ID,
        accountId: account.accountId,
      });
      if (this.gateway.isCurrent(scope)) {
        await this.context.channels.refresh(true);
      }
    } catch (err) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(err);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.accountOperationId = null;
      }
    }
  }

  override render() {
    const channels = this.context.channels.state;
    const accounts = resolveChannelAccounts(
      channels.channelsSnapshot?.channelAccounts,
      WEIXIN_PLUGIN_ID,
    );
    const connected = channels.connected;
    const installed = this.plugin?.installed === true || accounts.length > 0;
    const enabled = this.plugin?.enabled === true || accounts.length > 0;
    const pluginReady = installed && enabled && !this.plugin?.error;
    const canManageAccounts = hasOperatorAdminAccess(
      this.context.gateway.snapshot.hello?.auth ?? null,
    );
    const channelStatus = asNullableRecord(channels.channelsSnapshot?.channels[WEIXIN_PLUGIN_ID]);
    const supportsAccountLogin =
      channelStatus?.controlUiAccountManagement === true &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "channels.login.start") === true;
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("wechat")}</div>
          <div class="page-subtitle">${subtitleForRoute("wechat")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(html`
        ${!connected
          ? html`<p class="wechat-bind__offline">${t("wechatPage.offline")}</p>`
          : html`
              ${this.renderPluginSection(installed, enabled)}
              ${pluginReady
                ? !supportsAccountLogin
                  ? this.renderGatewayUpgradeRequired()
                  : !canManageAccounts || this.addPhase === "list"
                    ? this.renderAccountList(accounts, canManageAccounts)
                    : this.renderAddAccountFlow()
                : nothing}
              <div class="wechat-bind__footer-actions">
                <wa-button
                  variant="default"
                  ?loading=${this.refreshBusy}
                  @click=${() => void this.refresh(true)}
                  >${this.refreshBusy
                    ? t("wechatPage.refreshing")
                    : t("wechatPage.refresh")}</wa-button
                >
                <a href=${pathForRoute("channels", this.context.basePath)}
                  >${t("wechatPage.advanced")}</a
                >
              </div>
            `}
      `)}
    `;
  }

  private renderPluginSection(installed: boolean, enabled: boolean) {
    return html`
      <section class="settings-section">
        <div class="settings-section__header">
          <div class="settings-section__copy">
            <h2 class="settings-section__heading">${t("wechatPage.pluginTitle")}</h2>
            <p class="settings-section__desc">${t("wechatPage.pluginDescription")}</p>
          </div>
        </div>
        ${this.pluginLoading && !this.plugin
          ? html`<p class="wechat-bind__message">${t("wechatPage.loading")}</p>`
          : this.error
            ? html`<p class="wechat-bind__error">${this.error}</p>`
            : this.plugin?.error
              ? html`<p class="wechat-bind__error">${this.plugin.error}</p>`
              : !installed
                ? html`
                    <p class="wechat-bind__message">${t("wechatPage.installDescription")}</p>
                    ${renderConnectCommand(WEIXIN_INSTALL_COMMAND)}
                  `
                : !enabled
                  ? html`
                      <p class="wechat-bind__message">${t("wechatPage.enableDescription")}</p>
                      ${renderConnectCommand(WEIXIN_ENABLE_COMMAND)}
                    `
                  : html`<p class="wechat-bind__success">${t("wechatPage.pluginReady")}</p>`}
      </section>
    `;
  }

  private renderGatewayUpgradeRequired() {
    return html`
      <section class="settings-section">
        <p class="wechat-bind__message">${t("wechatPage.gatewayUpgradeRequired")}</p>
      </section>
    `;
  }

  private renderAccountList(accounts: ChannelAccountSnapshot[], canManageAccounts: boolean) {
    return html`
      <section class="settings-section">
        <div class="settings-section__header">
          <div class="settings-section__copy">
            <h2 class="settings-section__heading">${t("wechatPage.accountsTitle")}</h2>
            <p class="settings-section__desc">${t("wechatPage.accountsDescription")}</p>
          </div>
          ${canManageAccounts
            ? html`
                <div class="settings-section__actions">
                  <wa-button variant="brand" @click=${() => void this.startAddAccount()}
                    >${t("wechatPage.addAccount")}</wa-button
                  >
                </div>
              `
            : nothing}
        </div>
        ${!canManageAccounts
          ? html`<p class="wechat-bind__message">${t("wechatPage.administratorRequired")}</p>`
          : nothing}
        ${accounts.length === 0
          ? html`<p class="wechat-bind__message">${t("wechatPage.noAccounts")}</p>`
          : html`<ul class="wechat-accounts">
              ${accounts.map((account) => this.renderAccount(account, canManageAccounts))}
            </ul>`}
      </section>
    `;
  }

  private renderAccount(account: ChannelAccountSnapshot, canManageAccounts: boolean) {
    const label = account.name || account.accountId;
    const status = account.running
      ? t("channels.hub.stateRunning")
      : account.configured
        ? t("channels.hub.stateConfigured")
        : t("channels.hub.stateAttention");
    return html`
      <li class="wechat-account">
        <div class="wechat-account__copy">
          <span class="wechat-account__label">${label}</span>
          <span class="wechat-account__id">${account.accountId}</span>
        </div>
        <span class="wechat-account__status">${status}</span>
        ${canManageAccounts
          ? html`
              <wa-button
                variant="danger"
                size="small"
                ?loading=${this.accountOperationId === account.accountId}
                @click=${() => void this.removeAccount(account)}
                >${t("wechatPage.removeAccount")}</wa-button
              >
            `
          : nothing}
      </li>
    `;
  }

  private renderAddAccountFlow() {
    if (this.addPhase === "success") {
      return html`
        <section class="settings-section">
          <p class="wechat-bind__success">${this.loginMessage}</p>
          <wa-button variant="brand" @click=${() => this.cancelAddAccount()}
            >${t("wechatPage.backToAccounts")}</wa-button
          >
        </section>
      `;
    }
    if (this.addPhase === "error") {
      return html`
        <section class="settings-section">
          <p class="wechat-bind__error">${this.loginMessage}</p>
          <div class="wechat-bind__actions">
            <wa-button variant="brand" @click=${() => this.cancelAddAccount()}
              >${t("wechatPage.retry")}</wa-button
            >
            <wa-button variant="default" @click=${() => this.cancelAddAccount()}
              >${t("common.cancel")}</wa-button
            >
          </div>
        </section>
      `;
    }
    return html`
      <section class="settings-section">
        <div class="settings-section__header">
          <div class="settings-section__copy">
            <h2 class="settings-section__heading">${t("wechatPage.addAccount")}</h2>
            <p class="settings-section__desc">${t("wechatPage.scanDescription")}</p>
          </div>
        </div>
        <div class="wechat-bind">
          ${this.addPhase === "starting"
            ? html`<p class="wechat-bind__message">${t("wechatPage.preparingQr")}</p>`
            : this.qrDataUrl
              ? html`<img
                  class="wechat-bind__qr"
                  src=${this.qrDataUrl}
                  alt=${t("wechatPage.scanHint")}
                  width="320"
                  height="320"
                />`
              : nothing}
          ${this.loginMessage
            ? html`<p class="wechat-bind__message">${this.loginMessage}</p>`
            : nothing}
          ${this.addPhase === "verification"
            ? html`
                <label class="wechat-bind__verify">
                  <span>${t("wechatPage.verifyCodeLabel")}</span>
                  <input
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    .value=${this.verifyCode}
                    @input=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        this.verifyCode = event.currentTarget.value;
                      }
                    }}
                    @keydown=${(event: KeyboardEvent) => {
                      if (event.key === "Enter") {
                        this.submitVerification();
                      }
                    }}
                  />
                </label>
                <wa-button variant="brand" @click=${() => this.submitVerification()}
                  >${t("wechatPage.submitVerifyCode")}</wa-button
                >
              `
            : nothing}
          <wa-button variant="default" @click=${() => this.cancelAddAccount()}
            >${t("common.cancel")}</wa-button
          >
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-wechat-page")) {
  customElements.define("openclaw-wechat-page", WechatPage);
}
