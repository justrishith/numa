# YouTube Music on Windows

## Findings

- This machine has the desktop app installed at `C:\Users\krish\AppData\Local\Programs\youtube-music\YouTube Music.exe`.
- Windows Start Apps reports it as `YouTube Music`, AppUserModelID `com.github.th-ch.youtube-music`.
- The installed app is the unofficial `th-ch/youtube-music` desktop project, not an official Google Windows executable. Its upstream README describes it as an independent, unofficial desktop experience and documents Windows distribution.
- Google Chrome's official help documents installing websites as standalone web apps. That is a fallback, not the preferred path here because the native YouTube Music desktop app is already installed.

## NUMA decision

NUMA should launch the installed YouTube Music executable directly and pass the YouTube Music search URL as its argument. If the executable is unavailable, it may use the registered AppUserModelID, then fall back to a browser app window/URL.

## Sources

- Upstream desktop app: https://github.com/th-ch/youtube-music
- Google Chrome web-app documentation: https://support.google.com/chrome/answer/9658361
