// Theme tokens for ghostel.app enterprise dark UI
export const theme = {
  colors: {
    background: '#0f1419',
    surface: '#1a2332',
    surfaceSecondary: '#243042',
    primary: '#00d9ff',
    primaryDark: '#004b66',
    textPrimary: '#e1e8ed',
    textSecondary: '#8b9eb0',
    textMuted: '#5d6f82',
    success: '#00ba88',
    error: '#ff5757',
    warning: '#ffb340',
    border: '#2c3b4e',
    bubbleReceived: '#1a2332',
    bubbleSent: '#004b66',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
  },
  radius: {
    sm: 6,
    md: 10,
    lg: 16,
    xl: 24,
    pill: 999,
  },
  font: {
    h1: 28,
    h2: 22,
    h3: 18,
    body: 15,
    small: 13,
    tiny: 11,
  },
};

export const statusColor = (s?: string) => {
  switch (s) {
    case 'online':
      return theme.colors.success;
    case 'busy':
      return theme.colors.error;
    case 'away':
      return theme.colors.warning;
    case 'offline':
      return theme.colors.textMuted;
    default:
      return theme.colors.success;
  }
};
