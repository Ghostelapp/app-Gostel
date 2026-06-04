import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { theme, statusColor } from './theme';

type Props = {
  name: string;
  size?: number;
  color?: string;
  status?: string;
  showStatus?: boolean;
  photo?: string | null; // base64 data URI or remote URL
};

export default function Avatar({
  name,
  size = 44,
  color,
  status,
  showStatus = false,
  photo,
}: Props) {
  const initials = (name || '?')
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const bg = color || theme.colors.primary;
  const hasPhoto = !!photo && photo.length > 30;

  return (
    <View style={{ width: size, height: size }}>
      {hasPhoto ? (
        <Image
          source={{ uri: photo! }}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: bg,
          }}
        />
      ) : (
        <View
          style={[
            styles.avatar,
            { width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
          ]}
        >
          <Text style={[styles.initials, { fontSize: size * 0.4 }]}>{initials}</Text>
        </View>
      )}
      {showStatus && (
        <View
          testID="avatar-status-dot"
          style={[
            styles.dot,
            {
              width: size * 0.28,
              height: size * 0.28,
              borderRadius: size * 0.14,
              backgroundColor: statusColor(status),
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    color: '#0f1419',
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  dot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    borderWidth: 2,
    borderColor: theme.colors.background,
  },
});
