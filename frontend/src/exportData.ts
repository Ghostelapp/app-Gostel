/**
 * GDPR data export — fetches the JSON dump from the API, writes it to the
 * device cache directory and opens the OS share sheet so the user can save it
 * (Files, email, drive, etc.).
 *
 * Falls back to React Native's built-in `Share` API (text) if `expo-sharing`
 * is not available on the platform (e.g. web).
 */
import { Alert, Platform, Share } from 'react-native';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import type { TFunction } from 'i18next';
import { api, formatApiErrorDetail } from './api';

export async function exportMyData(t: TFunction): Promise<void> {
  try {
    const { data } = await api.get('/users/me/export');
    const json = JSON.stringify(data, null, 2);

    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `ghostel-export-${stamp}.json`;

    if (Platform.OS === 'web') {
      // Fall back to RN Share (works in web preview via browser share)
      try {
        await Share.share({
          title: filename,
          message: json,
        });
      } catch {
        Alert.alert(t('export.nothing_to_share'));
      }
      return;
    }

    // Write to cache and open share sheet
    const file = new File(Paths.cache, filename);
    try {
      // Remove any stale file with the same name (very unlikely but safe)
      if (file.exists) file.delete();
    } catch {
      /* ignore */
    }
    file.create();
    file.write(json);

    const available = await Sharing.isAvailableAsync();
    if (!available) {
      Alert.alert(t('export.nothing_to_share'));
      return;
    }
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      dialogTitle: t('profile.export_data'),
      UTI: 'public.json',
    });
  } catch (e) {
    Alert.alert(t('export.failed'), formatApiErrorDetail(e));
  }
}
