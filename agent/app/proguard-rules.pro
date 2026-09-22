# kotlinx.serialization 生成的序列化器必须保留
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.xfish.comment.agent.**$$serializer { *; }
-keepclassmembers class com.xfish.comment.agent.** {
    *** Companion;
}
-keepclasseswithmembers class com.xfish.comment.agent.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Room
-keep class * extends androidx.room.RoomDatabase
-dontwarn androidx.room.paging.**

# 无障碍服务由系统反射实例化，不能混淆类名
-keep class com.xfish.comment.agent.accessibility.AutoService { *; }
-keep class com.xfish.comment.agent.runtime.AgentService { *; }
-keep class com.xfish.comment.agent.runtime.BootReceiver { *; }
