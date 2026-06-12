/**
 * Helpers around expo-image-picker for avatar uploads.
 *
 * - Asks the user whether to use camera or photo gallery.
 * - Returns the raw picked asset (uri + width + height); the caller is
 *   responsible for showing a crop UI (see AvatarCropperModal).
 */
import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform } from 'react-native';
import type { TFunction } from 'i18next';

type Choice = 'camera' | 'gallery' | null;

export type RawPickedImage = {
  uri: string;
  width: number;
  height: number;
};

async function ask(t: TFunction): Promise<Choice> {
  return new Promise<Choice>((resolve) => {
    Alert.alert(
      t('photo.title'),
      undefined,
      [
        { text: t('photo.take_photo'), onPress: () => resolve('camera') },
        { text: t('photo.choose_gallery'), onPress: () => resolve('gallery') },
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}

/**
 * Pick an image without any cropping. Caller should then display a custom
 * cropper (e.g. AvatarCropperModal). Returns null if user cancelled or denied.
 */
export async function pickRawImage(t: TFunction): Promise<RawPickedImage | null> {
  const choice = await ask(t);
  if (!choice) return null;

  const isCamera = choice === 'camera';
  const perm = isCamera
    ? await ImagePicker.requestCameraPermissionsAsync()
    : Platform.OS === 'android'
      ? { granted: true }
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    Alert.alert(t('common.error'), t('photo.permission_denied'));
    return null;
  }

  const opts: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    base64: false,
  };

  const res = isCamera
    ? await ImagePicker.launchCameraAsync(opts)
    : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled || !res.assets?.[0]) return null;
  const a = res.assets[0];
  if (!a.uri || !a.width || !a.height) return null;
  return { uri: a.uri, width: a.width, height: a.height };
}
