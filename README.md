# Game Orchestra

![GitHub release](https://img.shields.io/github/v/release/Anomander/game-orchestra?style=for-the-badge)
![GitHub Downloads (specific asset, all releases)](https://img.shields.io/github/downloads/Anomander/game-orchestra/module.zip?style=for-the-badge&logo=foundryvirtualtabletop&logoColor=white&logoSize=auto&label=Downloads%20(Total)&color=ff144f)
![GitHub Downloads (specific asset, latest release)](https://img.shields.io/github/downloads/Anomander/game-orchestra/latest/module.zip?sort=date&style=for-the-badge&logo=foundryvirtualtabletop&logoColor=white&logoSize=auto&label=Downloads%20(Latest)&color=ff144f)

![Foundry Version](https://img.shields.io/endpoint?url=https%3A%2F%2Ffoundryshields.com%2Fversion%3Fstyle%3Dfor-the-badge%26url%3Dhttps%3A%2F%2Fgithub.com%2FAnomander%2Fgame-orchestra%2Freleases%2Flatest%2Fdownload%2Fmodule.json)

## Overview

**Game Orchestra** adds dynamic, context-aware audio management to FoundryVTT. It automatically switches between area and combat music based on game state, tracks playback position so music resumes where it left off, and supports visual node-based custom playback graphs.

## Features

- **Area & Combat Music** — assign playlists per-scene for exploration and combat
- **Per-Token Themes** — give individual tokens their own combat music via Token Config
- **Priority System** — control which music wins when multiple sources apply
- **Moods & Phases** — define custom mood/phase overlays and per-overlay playlist overrides on top of scene, token, and world-default music; switch active moods with the dockable Mood Widget
- **Additive Overlays** — a mood, a phase, or a combatant's theme can play *on top of* the base music instead of replacing it, optionally ducking everything underneath while it does
- **Playlist Hierarchy Tree** — a manager window for reviewing and editing area/combat/mood assignments across every scene and world defaults in one place
- **Custom Playback Graphs** — design a playlist's playback rules (sequences, weighted shuffles, parallel layers, delays, game-state branches) as a visual node graph instead of relying on Foundry's built-in modes
- **Crossfade & Gapless Transitions** — adjustable fade duration and pre-fetch engine for smooth transitions between tracks
- **Position Memory** — tracks resume from where they were interrupted
- **Suppression Controls** — toggle area or combat music on/off with hotkeys or scene controls

## Custom Playback Graphs

Any playlist can be given its own playback graph, built with a visual node editor (Start, Track, Fork, Delay, Random, Condition, and Playlist nodes) instead of using Foundry's built-in Sequential/Shuffle/Simultaneous modes.

Open it by right-clicking the playlist in the Playlists sidebar and choosing **Playback Graph**, or from the button on the playlist's config sheet. Saving applies the graph immediately and keeps the editor open, so you can watch playback move through the nodes and keep editing. Select a node before adding another and the new one wires itself on; drop a track onto an existing Track node to swap that node's sound.

A **Playlist** node plays another playlist by that playlist's own rules — its own graph if it has one, or its native Foundry mode otherwise — and moves on once that playlist finishes a full pass. The target can be a **direct** reference to a specific playlist, or an **indirect** one that resolves at playback time to the current scene's (or world default's) area or combat playlist.

## Installation

Install through Foundry's module browser, or paste the manifest URL:

```
https://github.com/Anomander/game-orchestra/releases/latest/download/module.json
```

## Setup

1. **Scene music** — open Scene Config, click the music configuration button to assign area and combat playlists
2. **Token music** — open Token Config (or Prototype Token), find the music button in the Identity tab to assign combat themes
3. **Linked token override** — linked tokens can optionally use their own music instead of the actor's prototype config
4. **Default music** — set a world-level fallback in module settings
5. **Moods & Phases** — configure custom moods and per-mood overrides from settings, or manage everything at once from the Playlist Hierarchy Tree
6. **Settings** — configure fade duration and suppression hotkeys

## Keyboard Shortcuts

All GM-only, and all rebindable in *Configure Controls*.

| Shortcut | Action |
|---|---|
| `Alt+O` | Open/close the Game Orchestra panel |
| `Alt+M` | Open/close the Mood Widget |
| `Alt+A` | Toggle area music suppression |
| `Alt+C` | Toggle combat music suppression |

## Settings

| Setting | Description |
|---|---|
| Fade Duration | Crossfade time in seconds (0 = use per-sound fade) |
| Default Music | World-level fallback combat playlist |

## Support

- [GitHub Issues](https://github.com/Anomander/game-orchestra/issues)

