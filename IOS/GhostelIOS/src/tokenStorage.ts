import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export const TOKEN_KEY = 'silentel_token';

const canUseSecureStore = Platform.OS !== 'web';

export async function getStoredToken(): Promise<string | null> {
  if (!canUseSecureStore) {
    return AsyncStorage.getItem(TOKEN_KEY);
  }

  try {
    const secureToken = await SecureStore.getItemAsync(TOKEN_KEY);
    if (secureToken) return secureToken;

    const legacyToken = await AsyncStorage.getItem(TOKEN_KEY);
    if (legacyToken) {
      await SecureStore.setItemAsync(TOKEN_KEY, legacyToken);
      await AsyncStorage.removeItem(TOKEN_KEY);
    }
    return legacyToken;
  } catch {
    return AsyncStorage.getItem(TOKEN_KEY);
  }
}

export async function setStoredToken(token: string): Promise<void> {
  if (!canUseSecureStore) {
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return;
  }

  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    await AsyncStorage.setItem(TOKEN_KEY, token);
  }
}

export async function removeStoredToken(): Promise<void> {
  if (canUseSecureStore) {
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    } catch {
      /* fallback below */
    }
  }
  await AsyncStorage.removeItem(TOKEN_KEY);
}
