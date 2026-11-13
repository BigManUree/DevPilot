/** DevPilot 设计 Token：CSS Variables 与 Ant Design 共用同一组色板。 */
import { theme as antdAlgorithms, type ThemeConfig } from 'antd';

export type ThemeMode = 'system' | 'light' | 'dark';

export const palettes = {
  light: {
    bg: '#F8FAFC', card: '#FFFFFF', headerBg: '#FFFFFF', siderBg: '#FFFFFF',
    elevated: '#FFFFFF', subtle: '#F8FAFC', border: '#E2E8F0', borderStrong: '#CBD5E1',
    text: '#1E293B', textSecondary: '#64748B', textTertiary: '#94A3B8',
    primary: '#3B82F6', primaryHover: '#2563EB', primarySoft: '#EAF2FF', hover: '#EFF6FF',
    success: '#16A34A', successBg: '#F0FDF4', danger: '#DC2626', dangerBg: '#FEF2F2',
    warning: '#D97706', warningBg: '#FFFBEB', infoBg: '#EFF6FF',
    tableHead: '#F8FAFC', codeBg: '#F8FAFC', overlay: 'rgba(15, 23, 42, 0.45)',
  },
  dark: {
    bg: '#111827', card: '#1E293B', headerBg: '#111827', siderBg: '#151D2B',
    elevated: '#243247', subtle: '#182234', border: '#334155', borderStrong: '#475569',
    text: '#F1F5F9', textSecondary: '#94A3B8', textTertiary: '#64748B',
    primary: '#60A5FA', primaryHover: '#93C5FD', primarySoft: '#1E3A5F', hover: '#263449',
    success: '#4ADE80', successBg: '#142C22', danger: '#F87171', dangerBg: '#341C24',
    warning: '#FBBF24', warningBg: '#342916', infoBg: '#172C46',
    tableHead: '#182234', codeBg: '#0F172A', overlay: 'rgba(0, 0, 0, 0.65)',
  },
} as const;

export const colors = palettes.light;
export const systemFont = '"Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif';
export const monoFont = '"Cascadia Code", "SFMono-Regular", Consolas, monospace';

export function buildAntdTheme(dark: boolean): ThemeConfig {
  const p = dark ? palettes.dark : palettes.light;
  return {
    algorithm: dark ? antdAlgorithms.darkAlgorithm : antdAlgorithms.defaultAlgorithm,
    cssVar: false,
    token: {
      colorPrimary: p.primary, colorInfo: p.primary, colorSuccess: p.success,
      colorError: p.danger, colorWarning: p.warning,
      colorBgLayout: p.bg, colorBgContainer: p.card, colorBgElevated: p.elevated,
      colorFillSecondary: p.subtle, colorFillTertiary: p.hover,
      colorBorder: p.border, colorBorderSecondary: p.border,
      colorText: p.text, colorTextSecondary: p.textSecondary, colorTextTertiary: p.textTertiary,
      colorTextQuaternary: p.textTertiary, colorBgMask: p.overlay,
      borderRadius: 8, borderRadiusSM: 6, borderRadiusLG: 10,
      fontFamily: systemFont, fontSize: 13, lineHeight: 1.5715,
      controlHeight: 32, controlHeightSM: 28,
      boxShadow: 'none',
      boxShadowSecondary: dark ? '0 16px 40px rgba(0,0,0,.38)' : '0 12px 32px rgba(15,23,42,.10)',
      motionDurationFast: '0.15s', motionDurationMid: '0.2s',
    },
    components: {
      Layout: { bodyBg: p.bg, headerBg: p.headerBg, siderBg: p.siderBg },
      Card: { boxShadowTertiary: 'none', paddingLG: 20, headerFontSize: 14, headerHeight: 48 },
      Table: { headerBg: p.tableHead, headerColor: p.textSecondary, cellPaddingBlockSM: 10, rowHoverBg: p.subtle },
      Menu: {
        itemBg: 'transparent', itemColor: p.textSecondary, itemHoverBg: p.hover,
        itemHoverColor: p.text, itemSelectedBg: p.primarySoft, itemSelectedColor: p.primary,
        itemBorderRadius: 7, itemMarginInline: 10, itemHeight: 36,
        groupTitleColor: p.textTertiary, groupTitleFontSize: 11,
      },
      Button: {
        borderRadius: 7, controlHeight: 32, controlHeightSM: 28,
        primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none',
        colorPrimary: p.primary, colorPrimaryHover: p.primaryHover, colorPrimaryActive: p.primaryHover,
        defaultBg: p.card, defaultBorderColor: p.border, defaultHoverBorderColor: p.primary,
      },
      Input: { borderRadius: 7, activeShadow: `0 0 0 3px ${p.primarySoft}`, activeBorderColor: p.primary, hoverBorderColor: p.borderStrong },
      Select: { borderRadius: 7, activeBorderColor: p.primary, hoverBorderColor: p.borderStrong },
      Modal: { borderRadiusLG: 12, headerBg: p.card, contentBg: p.card },
      Drawer: { colorBgElevated: p.card },
      Dropdown: { borderRadiusLG: 10, controlPaddingHorizontal: 12 },
      Tabs: { itemSelectedColor: p.primary, itemHoverColor: p.primary, inkBarColor: p.primary },
      Tag: { borderRadiusSM: 5 },
      Tooltip: { borderRadius: 6 },
      Message: { contentBg: p.elevated },
      Notification: { colorBgElevated: p.elevated },
    },
  };
}

export const antdTheme: ThemeConfig = buildAntdTheme(false);
