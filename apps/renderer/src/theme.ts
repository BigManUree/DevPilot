/** DevPilot 桌面工作台主题：浅色 / 深色两套中性调色板 + antd token。系统字体，不加载远程资源。 */
import { theme as antdAlgorithms, type ThemeConfig } from 'antd';

export type ThemeMode = 'system' | 'light' | 'dark';

export const palettes = {
  light: {
    bg: '#F6F7F9',
    card: '#FFFFFF',
    headerBg: '#FFFFFF',
    siderBg: '#FBFBFC',
    border: '#E4E7EC',
    borderStrong: '#D0D5DD',
    text: '#1F2329',
    textSecondary: '#667085',
    textTertiary: '#98A2B3',
    primary: '#2563EB',
    primarySoft: '#EFF4FF',
    success: '#15803D',
    danger: '#DC2626',
    warning: '#B45309',
    hover: '#F2F4F7',
    tableHead: '#FAFAFB',
    codeBg: '#FAFAFB',
  },
  dark: {
    bg: '#15171B',
    card: '#1D2026',
    headerBg: '#1A1D22',
    siderBg: '#191C21',
    border: '#2B3038',
    borderStrong: '#3A4049',
    text: '#E6E8EB',
    textSecondary: '#9BA3AF',
    textTertiary: '#6B7280',
    primary: '#6EA8FE',
    primarySoft: '#1D2A3D',
    success: '#4ADE80',
    danger: '#F87171',
    warning: '#FBBF24',
    hover: '#23272E',
    tableHead: '#20242A',
    codeBg: '#1A1D22',
  },
} as const;

/** 兼容旧引用：静态浅色值 */
export const colors = palettes.light;

export const systemFont =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif';
export const monoFont = '"Cascadia Code", Consolas, "Courier New", monospace';

/** 按深浅模式生成 antd 主题配置 */
export function buildAntdTheme(dark: boolean): ThemeConfig {
  const p = dark ? palettes.dark : palettes.light;
  return {
    algorithm: dark ? antdAlgorithms.darkAlgorithm : antdAlgorithms.defaultAlgorithm,
    token: {
      colorPrimary: p.primary,
      colorInfo: p.primary,
      colorSuccess: p.success,
      colorError: p.danger,
      colorWarning: p.warning,
      colorBgLayout: p.bg,
      colorBgContainer: p.card,
      colorBorder: p.border,
      colorBorderSecondary: p.border,
      colorText: p.text,
      colorTextSecondary: p.textSecondary,
      colorTextTertiary: p.textTertiary,
      borderRadius: 8,
      fontFamily: systemFont,
      fontSize: 13,
      boxShadow: 'none',
      boxShadowSecondary: dark ? '0 6px 20px rgba(0,0,0,0.5)' : '0 4px 16px rgba(16, 24, 40, 0.08)',
    },
    components: {
      Card: { boxShadowTertiary: 'none', paddingLG: 16 },
      Table: { headerBg: p.tableHead, headerColor: p.textSecondary, cellPaddingBlockSM: 8 },
      Menu: {
        itemBg: 'transparent',
        itemColor: p.textSecondary,
        itemSelectedBg: p.primarySoft,
        itemSelectedColor: p.primary,
        itemBorderRadius: 6,
        itemMarginInline: 8,
        groupTitleColor: p.textTertiary,
        groupTitleFontSize: 12,
      },
      Button: { borderRadius: 6, controlHeight: 30 },
      Input: { borderRadius: 6 },
      Select: { borderRadius: 6 },
      Modal: { borderRadiusLG: 10 },
      Tag: { borderRadiusSM: 4 },
    },
  };
}

/** 兼容旧调用：默认浅色 */
export const antdTheme: ThemeConfig = buildAntdTheme(false);
