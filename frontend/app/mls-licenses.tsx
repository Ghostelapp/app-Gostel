import React from 'react';
import { ScrollView, Text, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { MLS_LICENSE_NOTICES } from '../src/mls/licenses.generated';
import { theme } from '../src/theme';
export default function MLSLicenses() {
  const router = useRouter();
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
    <TouchableOpacity onPress={() => router.back()} style={{ padding: 16 }}><Text style={{ color: theme.colors.textPrimary }}>← Third-party licenses</Text></TouchableOpacity>
    <ScrollView contentContainerStyle={{ padding: 16 }}><Text selectable style={{ color: theme.colors.textPrimary, fontSize: 12 }}>{MLS_LICENSE_NOTICES}</Text></ScrollView>
  </SafeAreaView>;
}
