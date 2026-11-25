"""Adds Redpencil Phone's permissions, background service and call receiver to the Capacitor AndroidManifest.xml."""
import sys

path = sys.argv[1]
m = open(path, encoding='utf-8').read()

perms = [
    'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.CAMERA',
    'android.permission.VIBRATE', 'android.permission.WAKE_LOCK', 'android.permission.POST_NOTIFICATIONS',
    'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
    'android.permission.FOREGROUND_SERVICE_MICROPHONE', 'android.permission.USE_FULL_SCREEN_INTENT',
    'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', 'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.RECEIVE_BOOT_COMPLETED',
]
lines = ''.join('    <uses-permission android:name="%s" />\n' % p for p in perms if p not in m)
lines += '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n'
lines += '    <uses-feature android:name="android.hardware.microphone" android:required="false" />\n'
anchor = '<uses-permission android:name="android.permission.INTERNET" />'
assert anchor in m, 'INTERNET permission line not found'
m = m.replace(anchor, anchor + '\n' + lines, 1)

components = '''
        <service
            android:name=".CallService"
            android:exported="false"
            android:foregroundServiceType="specialUse|microphone">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="Keeps an office VoIP phone connected so incoming calls can ring" />
        </service>
        <receiver android:name=".CallActionReceiver" android:exported="false" />
        <receiver android:name=".BootReceiver" android:exported="true" android:directBootAware="false">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
            </intent-filter>
        </receiver>
    </application>'''
assert '</application>' in m
m = m.replace('</application>', components, 1)

open(path, 'w', encoding='utf-8').write(m)
for p in ['RECEIVE_BOOT_COMPLETED', '.BootReceiver', 'RECORD_AUDIO', 'FOREGROUND_SERVICE_SPECIAL_USE', 'USE_FULL_SCREEN_INTENT', '.CallService', '.CallActionReceiver']:
    assert p in m, p
print('manifest patched')
