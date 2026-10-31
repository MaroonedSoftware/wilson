// The Kotlin sources beside this file are GENERATED from `apps/api/data/contracts` by
// `@contractkit/plugin-kotlin`; run `pnpm codegen`. This build file is the one hand-written file here.
//
// A plain JVM library rather than Kotlin Multiplatform, because Android consumes one directly. The
// generated layout is KMP-shaped, so `src/commonMain` is named as the source root below.
//
// Both plugins are applied WITHOUT a version: the app takes AGP's built-in Kotlin, which puts the
// plugin on the classpath at a version Gradle reports as unknown and refuses to check one against.
plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.serialization")
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
    sourceSets["main"].kotlin.srcDir("src/commonMain/kotlin")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    // `api`: every one of these appears in the generated SDK's public signatures.
    api(libs.ktor.client.core)
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.datetime)
    api(libs.kotlinx.coroutines.core)
}
