# Character asset

`jarvis-character.png` is the original AI-generated falcon-inspired synthetic guardian created for this Jarvis project: charcoal metal, gold edges, violet eyes and illumination. It is supplied as a static master image; keep the pixels and transparency intact.

The app should animate position, glow, and code-drawn energy trails around it. Speaking movement must follow actual playback levels. A single PNG does not supply mouth lip-sync or a rigged 3D character. Use the same image for all states unless the user imports overrides.

Use the included image directly; do not replace it with the video's face, a remote stock image, or a placeholder when the file is available. Include it in application resources and make replacement possible through settings. Test for correct alpha handling, sharp small-size rendering, contain scaling, and no opaque backing rectangle. Package verification records image dimensions and mode in MANIFEST.json.

The image is an original generated concept, not the tutorial creator's asset. No separate model mesh, voice clone, or animated video is included.
