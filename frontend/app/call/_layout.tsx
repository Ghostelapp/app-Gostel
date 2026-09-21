import React from 'react';
import { Stack } from 'expo-router';

export default function CallLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#0f1419' },
        presentation: 'modal',
        // Dismissing this screen would tear down media without ending signaling.
        gestureEnabled: false,
      }}
    />
  );
}
