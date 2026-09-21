import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export const TOKEN_KEY = 'silentel_token';

let migratedLockedAccess = false;
const canUseSecureStore = Platform.OS !== 'web';

export async function getStoredToken(): Promise<string | null> {
  if (!canUseSecureStore) {
    return AsyncStorage.getItem(TOKEN_KEY);
  }

  try {
    const secureToken = await SecureStore.getItemAsync(TOKEN_KEY);
    if (secureToken) {
      if (Platform.OS === 'ios' && !migratedLockedAccess) {
        await SecureStore.setItemAsync(TOKEN_KEY, secureToken, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
        migratedLockedAccess = true;
      }
      return secureToken;
    }

    const legacyToken = await AsyncStorage.getItem(TOKEN_KEY);
    if (legacyToken) {
      await SecureStore.setItemAsync(TOKEN_KEY, legacyToken, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
      await AsyncStorage.removeItem(TOKEN_KEY);
    }
    return legacyToken;
  } catch (error) {
    throw new Error(`Secure token storage unavailable: ${String(error)}`);
  }
}

export async function setStoredToken(token: string): Promise<void> {
  if (!canUseSecureStore) {
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return;
  }

  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
    await AsyncStorage.removeItem(TOKEN_KEY);
  } catch (error) {
    throw new Error(`Secure token storage unavailable: ${String(error)}`);
  }
}

export async function removeStoredToken(): Promise<void> {
  let secureStoreError: unknown = null;
  if (canUseSecureStore) {
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    } catch (error) {
      secureStoreError = error;
    }
  }
  await AsyncStorage.removeItem(TOKEN_KEY);
  if (secureStoreError) {
    throw new Error(`Secure token storage unavailable: ${String(secureStoreError)}`);
  }
}
