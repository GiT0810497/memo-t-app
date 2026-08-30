import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";

const mocks = vi.hoisted(() => ({
  showConfirmDialog: vi.fn(async () => true),
}));

vi.mock("qrcode", () => ({
  default: {
    toDataURL: async () => "data:image/png;base64,weixin",
  },
}));

vi.mock("../../components/confirm-dialog.ts", () => ({
  showConfirmDialog: mocks.showConfirmDialog,
}));

import "./wechat-page.ts";

type WechatPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
};

type TestGateway = ApplicationContext["gateway"];

const emptyChannelSnapshot = {
  ts: 0,
  channelOrder: [],
  channelLabels: {},
  channels: {},
  channelAccounts: {},
  channelDefaultAccountId: {},
};

function createGateway(
  plugin: PluginCatalogItem,
  supportsAccountLogin = true,
  canManageAccounts = true,
) {
  const request = vi.fn(async (method: string) => {
    if (method === "plugins.list") {
      return { plugins: [plugin], diagnostics: [], mutationAllowed: true };
    }
    if (method === "channels.status") {
      return plugin.enabled
        ? {
            ...emptyChannelSnapshot,
            channels: {
              "openclaw-weixin": { controlUiAccountManagement: true },
            },
          }
        : emptyChannelSnapshot;
    }
    if (method === "channels.login.start") {
      return {
        qrDataUrl: "weixin-qr-content",
        message: "请扫码",
        sessionKey: "session-1",
      };
    }
    if (method === "channels.login.wait") {
      return { connected: false, message: "等待扫码确认" };
    }
    if (method === "channels.logout") {
      return { channel: "openclaw-weixin", accountId: "sales", cleared: true };
    }
    return {};
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: {
      auth: {
        role: "operator",
        scopes: [canManageAccounts ? "operator.admin" : "operator.read"],
      },
      features: {
        methods: supportsAccountLogin
          ? ["channels.login.start", "channels.login.wait", "channels.logout"]
          : ["channels.logout"],
      },
    } as unknown as ApplicationGatewaySnapshot["hello"],
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    snapshot,
    connection: { gatewayUrl: "", token: "", password: "" },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as TestGateway;
  return { gateway, request };
}

function createContext(
  plugin: PluginCatalogItem,
  supportsAccountLogin = true,
  canManageAccounts = true,
) {
  const source = createGateway(plugin, supportsAccountLogin, canManageAccounts);
  const channels = createChannelCapability(source.gateway);
  channels.state.channelsSnapshot = plugin.enabled
    ? {
        ...emptyChannelSnapshot,
        channels: {
          "openclaw-weixin": { controlUiAccountManagement: true },
        },
      }
    : emptyChannelSnapshot;
  return {
    context: {
      basePath: "",
      gateway: source.gateway,
      channels,
    } as unknown as ApplicationContext,
    channels,
    request: source.request,
  };
}

async function renderPage(
  plugin: PluginCatalogItem,
  supportsAccountLogin = true,
  canManageAccounts = true,
) {
  const source = createContext(plugin, supportsAccountLogin, canManageAccounts);
  const page = document.createElement("openclaw-wechat-page") as WechatPageTestElement;
  page.context = source.context;
  document.body.append(page);
  await page.updateComplete;
  return { page, ...source };
}

function findButton(page: HTMLElement, label: string): HTMLElement | undefined {
  return Array.from(page.querySelectorAll("wa-button")).find((button) =>
    button.textContent?.includes(label),
  );
}

const enabledPlugin: PluginCatalogItem = {
  id: "openclaw-weixin",
  name: "Weixin",
  packageName: "@tencent-weixin/openclaw-weixin",
  installed: true,
  enabled: true,
  state: "enabled",
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("WechatPage account management", () => {
  it("shows the official installer when the plugin is not installed", async () => {
    const { page, channels } = await renderPage({
      id: "openclaw-weixin",
      name: "Weixin",
      installed: false,
      enabled: false,
      state: "not-installed",
      install: { source: "official", pluginId: "openclaw-weixin" },
    });

    await vi.waitFor(() =>
      expect(page.textContent).toContain("@tencent-weixin/openclaw-weixin-cli install"),
    );
    channels.dispose();
  });

  it("gates account login when the Gateway does not advertise the new contract", async () => {
    const { page, channels } = await renderPage(enabledPlugin, false);

    await vi.waitFor(() => expect(page.textContent).toContain("请更新 Gateway"));
    expect(findButton(page, "添加账号")).toBeUndefined();
    channels.dispose();
  });

  it("renders account management read-only without administrator scope", async () => {
    const { page, channels } = await renderPage(enabledPlugin, true, false);

    await vi.waitFor(() => expect(page.textContent).toContain("需要管理员权限"));
    expect(findButton(page, "添加账号")).toBeUndefined();
    expect(findButton(page, "删除")).toBeUndefined();
    channels.dispose();
  });

  it("opens the add-account flow and renders the plugin QR content", async () => {
    const { page, channels, request } = await renderPage(enabledPlugin);
    await vi.waitFor(() => expect(page.textContent).toContain("已安装并启用"));

    findButton(page, "添加账号")?.click();

    await vi.waitFor(() =>
      expect(page.querySelector<HTMLImageElement>(".wechat-bind__qr")?.src).toBe(
        "data:image/png;base64,weixin",
      ),
    );
    expect(request).toHaveBeenCalledWith(
      "channels.login.start",
      expect.objectContaining({ channel: "openclaw-weixin", force: true }),
      { timeoutMs: 45_000 },
    );
    channels.dispose();
  });

  it("confirms and removes a bound account through the channel logout contract", async () => {
    const { page, channels, request } = await renderPage(enabledPlugin);
    await vi.waitFor(() => expect(page.textContent).toContain("已安装并启用"));
    channels.state.channelsSnapshot = {
      ...emptyChannelSnapshot,
      channelOrder: ["openclaw-weixin"],
      channels: {
        "openclaw-weixin": { controlUiAccountManagement: true },
      },
      channelAccounts: {
        "openclaw-weixin": [
          { accountId: "sales", name: "销售微信", configured: true, running: true },
        ],
      },
    };
    channels.state.channelsLastSuccess = Date.now();
    page.requestUpdate();
    await page.updateComplete;

    expect(findButton(page, "删除")).toBeDefined();
    findButton(page, "删除")?.click();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("channels.logout", {
        channel: "openclaw-weixin",
        accountId: "sales",
      }),
    );
    expect(mocks.showConfirmDialog).toHaveBeenCalled();
    channels.dispose();
  });
});
