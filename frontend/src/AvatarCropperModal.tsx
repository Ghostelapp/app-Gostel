/**
 * AvatarCropperModal — full-screen interactive crop UI for profile photos.
 *
 * UX:
 *   - User picks an image (camera/gallery) outside of this component.
 *   - This modal shows the image fitted to a square frame; a circular mask
 *     overlay indicates the visible profile-photo area.
 *   - User pans + pinches to position/scale.
 *   - "Save" → crops the image to the circle frame using expo-image-manipulator
 *     and returns a base64 JPEG data URI sized 512×512 (well under server limits).
 *
 * The cropper is implemented as a controlled Modal so the caller awaits the
 * promise returned by `cropAndExport()`.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Image,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  runOnJS,
  withTiming,
} from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import * as ImageManipulator from 'expo-image-manipulator';
import { Check, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { theme } from './theme';

type Props = {
  visible: boolean;
  uri: string | null;
  width: number; // original image width
  height: number; // original image height
  onCancel: () => void;
  onCropped: (dataUri: string) => void;
};

// Final exported size (square px). Larger = better quality, but bigger upload.
const OUTPUT_PX = 512;

export default function AvatarCropperModal({
  visible,
  uri,
  width,
  height,
  onCancel,
  onCropped,
}: Props) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  // Frame size (square mask) we render. Use ~320 on most phones.
  const FRAME = 320;

  // Initial "cover" scale so the smaller image dimension matches FRAME.
  const initialScale = (() => {
    if (!width || !height) return 1;
    const minDim = Math.min(width, height);
    if (!minDim) return 1;
    return FRAME / minDim;
  })();

  const scale = useSharedValue(initialScale);
  const savedScale = useSharedValue(initialScale);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  // Reset whenever a new image is loaded
  useEffect(() => {
    if (!visible) return;
    scale.value = initialScale;
    savedScale.value = initialScale;
    translateX.value = 0;
    translateY.value = 0;
    savedTx.value = 0;
    savedTy.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, uri, initialScale]);

  /** Clamp translation so the image always covers the frame fully. */
  const clamp = (tx: number, ty: number, s: number) => {
    'worklet';
    const scaledW = width * s;
    const scaledH = height * s;
    const maxX = Math.max(0, (scaledW - FRAME) / 2);
    const maxY = Math.max(0, (scaledH - FRAME) / 2);
    const clampedX = Math.max(-maxX, Math.min(maxX, tx));
    const clampedY = Math.max(-maxY, Math.min(maxY, ty));
    return { x: clampedX, y: clampedY };
  };

  const minScale = initialScale;
  const maxScale = initialScale * 5;

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onUpdate((e) => {
      const next = clamp(
        savedTx.value + e.translationX,
        savedTy.value + e.translationY,
        scale.value,
      );
      translateX.value = next.x;
      translateY.value = next.y;
    })
    .onEnd(() => {
      savedTx.value = translateX.value;
      savedTy.value = translateY.value;
    });

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      let s = savedScale.value * e.scale;
      if (s < minScale) s = minScale;
      if (s > maxScale) s = maxScale;
      scale.value = s;
      const next = clamp(translateX.value, translateY.value, s);
      translateX.value = next.x;
      translateY.value = next.y;
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedTx.value = translateX.value;
      savedTy.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      'worklet';
      // Reset on double tap
      scale.value = withTiming(initialScale);
      savedScale.value = initialScale;
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
      savedTx.value = 0;
      savedTy.value = 0;
    });

  const composed = Gesture.Simultaneous(pan, pinch, doubleTap);

  const imgStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // ---- Save: compute crop region in original-image coordinates ----
  const doSave = async () => {
    if (!uri || !width || !height) return;
    setSaving(true);
    try {
      // The image's effective on-screen size with current scale.
      const dispW = width * scale.value;
      const dispH = height * scale.value;
      // The frame is centered at (0,0) translation. To find the visible region
      // in image-space, we need to figure out which part of the *original*
      // image lies within the FRAME.
      // origin offset from image's top-left to frame's top-left (in display px):
      const offsetX = (dispW - FRAME) / 2 - translateX.value;
      const offsetY = (dispH - FRAME) / 2 - translateY.value;
      // Convert from display-px back to original-image-px by dividing by scale.
      const cropX = Math.max(0, offsetX / scale.value);
      const cropY = Math.max(0, offsetY / scale.value);
      const cropSize = FRAME / scale.value;
      const result = await ImageManipulator.manipulateAsync(
        uri,
        [
          {
            crop: {
              originX: cropX,
              originY: cropY,
              width: cropSize,
              height: cropSize,
            },
          },
          { resize: { width: OUTPUT_PX, height: OUTPUT_PX } },
        ],
        {
          compress: 0.85,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        },
      );
      if (result.base64) {
        onCropped(`data:image/jpeg;base64,${result.base64}`);
      } else {
        onCancel();
      }
    } catch (e) {
      console.warn('crop failed', e);
      onCancel();
    } finally {
      setSaving(false);
    }
  };

  if (!uri) return null;

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onCancel} transparent={false}>
      <GestureHandlerRootView style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel} testID="crop-cancel" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <X color="#fff" size={22} strokeWidth={2} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('photo.crop_title')}</Text>
          <TouchableOpacity onPress={doSave} disabled={saving} testID="crop-save">
            {saving ? (
              <ActivityIndicator color={theme.colors.primary} />
            ) : (
              <Check color={theme.colors.primary} size={22} strokeWidth={2.5} />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.frameWrap}>
          <View style={[styles.frame, { width: FRAME, height: FRAME }]}>
            <GestureDetector gesture={composed}>
              <View style={styles.frameInner} pointerEvents="auto">
                <Animated.Image
                  source={{ uri }}
                  style={[
                    {
                      width: width,
                      height: height,
                      position: 'absolute',
                      left: (FRAME - width) / 2,
                      top: (FRAME - height) / 2,
                    },
                    imgStyle,
                  ]}
                  resizeMode="cover"
                />
              </View>
            </GestureDetector>
            {/* Circular mask overlay (visual only, doesn't block gestures) */}
            <View
              style={[
                styles.circleMask,
                { width: FRAME, height: FRAME, borderRadius: FRAME / 2 },
              ]}
              pointerEvents="none"
            />
          </View>

          <Text style={styles.hint}>{t('photo.crop_hint')}</Text>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    paddingTop: Platform.OS === 'android' ? 16 : 50,
  },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  frameWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    overflow: 'hidden',
    backgroundColor: '#111',
    position: 'relative',
  },
  frameInner: { flex: 1, overflow: 'hidden' },
  circleMask: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: theme.colors.primary,
    backgroundColor: 'transparent',
    // Faux mask using a single thick border that doesn't actually clip — we
    // rely on the frame's overflow:hidden + circular border to show the
    // intended profile-photo area. The image inside is square; the user sees
    // a circle preview thanks to the colored ring.
  },
  hint: {
    color: '#aaa',
    fontSize: 13,
    marginTop: 32,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
});
