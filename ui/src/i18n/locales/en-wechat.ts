import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// The appliance WeChat page is Chinese-first and lazy-loaded with its route so
// account-management copy does not tax every Control UI startup.
const enWechat = {
  wechatPage: {
    pluginTitle: "微信连接组件",
    pluginDescription: "本页面使用腾讯维护的 @tencent-weixin/openclaw-weixin 插件连接微信。",
    loading: "正在检查插件状态…",
    installDescription: "请先在运行 Gateway 的设备上安装官方微信插件。",
    enableDescription: "请启用微信插件并重启 Gateway。",
    pluginReady: "微信连接组件已安装并启用。",
    gatewayUpgradeRequired:
      "当前 Gateway 或微信连接组件版本不支持页面扫码登录，请更新 Gateway 和微信连接组件后刷新页面。",
    accountsTitle: "微信账号",
    accountsDescription: "添加、查看或删除此设备连接的微信账号。",
    administratorRequired: "需要管理员权限才能添加或删除微信账号。",
    noAccounts: "还没有添加微信账号。",
    addAccount: "添加账号",
    scanDescription: "请使用手机微信扫描二维码，并在手机上确认连接。",
    preparingQr: "正在生成微信二维码…",
    scanHint: "使用微信扫描此二维码",
    verifyCodeLabel: "输入手机微信中显示的数字",
    submitVerifyCode: "确认",
    loginFailed: "无法启动微信登录。",
    loginSuccess: "微信账号添加成功。",
    backToAccounts: "返回账号列表",
    retry: "重新尝试",
    removeAccount: "删除",
    removeConfirmTitle: "删除 {account}？",
    removeConfirmMessage: "这会删除此 OpenClaw 设备上的账号凭据和本地绑定。",
    refresh: "刷新状态",
    refreshing: "正在刷新…",
    offline: "请先连接 Gateway，再管理微信账号。",
    advanced: "渠道高级设置",
  },
} satisfies TranslationMap;

export const registerWechatEnglish = Object.assign(
  () => {
    en.wechatPage = enWechat.wechatPage;
  },
  { catalog: enWechat },
);
