/** DevPilot 桌面工作台主题：浅色、低噪声、细边框。系统字体，不加载远程资源。 */
export const colors = {
  bg: '#F6F7F9',
  card: '#FFFFFF',
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
};

export const systemFont =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif';
export const monoFont = '"Cascadia Code", Consolas, "Courier New", monospace';

export const antdTheme = {
  token: {
    colorPrimary: colors.primary,
    colorInfo: colors.primary,
    colorSuccess: colors.success,
    colorError: colors.danger,
    colorWarning: colors.warning,
    colorBgLayout: colors.bg,
    colorBgContainer: colors.card,
    colorBorder: colors.border,
    colorBorderSecondary: colors.border,
    colorText: colors.text,
    colorTextSecondary: colors.textSecondary,
    colorTextTertiary: colors.textTertiary,
    borderRadius: 8,
    fontFamily: systemFont,
    fontSize: 13,
    boxShadow: 'none',
    boxShadowSecondary: '0 4px 16px rgba(16, 24, 40, 0.08)',
  },
  components: {
    Card: { boxShadowTertiary: 'none', paddingLG: 16 },
    Table: { headerBg: '#FAFAFB', headerColor: colors.textSecondary, cellPaddingBlockSM: 8 },
    Menu: {
      itemBg: 'transparent',
      itemColor: colors.textSecondary,
      itemSelectedBg: colors.primarySoft,
      itemSelectedColor: colors.primary,
      itemBorderRadius: 6,
      itemMarginInline: 8,
      groupTitleColor: colors.textTertiary,
      groupTitleFontSize: 12,
    },
    Button: { borderRadius: 6, controlHeight: 30 },
    Input: { borderRadius: 6 },
    Select: { borderRadius: 6 },
    Modal: { borderRadiusLG: 10 },
    Tag: { borderRadiusSM: 4 },
  },
} as const;
