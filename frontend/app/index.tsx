import React, { useEffect, useRef } from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ghost } from 'lucide-react-native';
import { useAuth } from '../src/auth';
import { theme } from '../src/theme';

function FloatingGhost({ delay, left, size }: { delay: number; left: `${number}%`; size: number }) {
  const float = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(float, { toValue: 1, duration: 1400, useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 1400, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [delay, float]);

  return (
    <Animated.View
      style={[
        styles.ghost,
        {
          left,
          opacity: float.interpolate({ inputRange: [0, 1], outputRange: [0.16, 0.6] }),
          transform: [
            { translateY: float.interpolate({ inputRange: [0, 1], outputRange: [14, -18] }) },
            { rotate: float.interpolate({ inputRange: [0, 1], outputRange: ['-8deg', '8deg'] }) },
          ],
        },
      ]}
    >
      <Ghost color={theme.colors.primary} size={size} strokeWidth={1.6} />
    </Animated.View>
  );
}

export default function Index() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/(tabs)/chats' : '/(auth)/login');
  }, [loading, router, user]);

  return (
    <View style={styles.center} testID="splash-loading">
      <FloatingGhost delay={0} left="14%" size={34} />
      <FloatingGhost delay={300} left="70%" size={42} />
      <FloatingGhost delay={650} left="43%" size={25} />
      <View style={styles.logoGlow} />
      <Image source={require('../assets/images/icon.png')} style={styles.logo} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 116,
    height: 116,
    borderRadius: 30,
  },
  logoGlow: {
    position: 'absolute',
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: theme.colors.primaryDark,
    opacity: 0.35,
  },
  ghost: {
    position: 'absolute',
    top: '43%',
  },
});
