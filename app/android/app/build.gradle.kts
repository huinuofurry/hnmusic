plugins {
    id("com.android.application")
}

android {
    namespace = "com.hnmusic.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.hnmusic.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        create("release") {
            storeFile = file("hnmusic.jks")
            storePassword = System.getenv("HN_KS_PASS") ?: "hnmusic2026"
            keyAlias = "hnmusic"
            keyPassword = System.getenv("HN_KS_PASS") ?: "hnmusic2026"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
