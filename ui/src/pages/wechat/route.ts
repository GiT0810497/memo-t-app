import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

function loadWechatRoute(context: ApplicationContext) {
  void context.channels.refresh(false);
}

export const page = definePage({
  ...routePageSpec("wechat"),
  loader: (context: ApplicationContext) => loadWechatRoute(context),
  component: () =>
    import("./wechat-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-wechat-page></openclaw-wechat-page>`,
    })),
});
