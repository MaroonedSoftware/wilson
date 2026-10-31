pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "wilson-android"
include(":app")

// Generated from the contracts, and beside the TypeScript SDK rather than inside this app.
include(":sdk")
project(":sdk").projectDir = file("../../packages/sdk-kotlin")
