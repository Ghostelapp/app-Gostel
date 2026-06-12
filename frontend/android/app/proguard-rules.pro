# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Native calling modules are loaded through React Native package registration
# and must remain available in optimized release builds.
-keep class io.wazo.callkeep.** { *; }
-keep class com.zxcpoiu.incallmanager.** { *; }
-keep class org.webrtc.** { *; }
-keep class app.ghostel.GhostelFirebaseMessagingService { *; }
-keep class app.ghostel.GhostelActiveCallService { *; }
-keep class app.ghostel.GhostelCallNotificationModule { *; }
