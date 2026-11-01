# kotlinx.serialization looks serializers up reflectively at the point a type is decoded. R8 cannot
# see that call, so without these a release build strips them and every decode fails on the phone.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

-keepclassmembers class **$$serializer { *** INSTANCE; }
-keepclassmembers @kotlinx.serialization.Serializable class ** {
    *** Companion;
    *** serializer(...);
}
