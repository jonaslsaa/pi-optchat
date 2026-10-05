# Third-party notices

## Victor Taelin's OptChat recipe

The OptChat memory design and the four prompt strings in `src/prompts.ts`
come from Victor Taelin's publicly shared implementation recipe:

https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449

That upstream text is credited to Victor Taelin and is not relicensed by this
repository's MIT grant for original implementation code. The complete recipe
is linked upstream. This project is an independent Pi extension.

## Pi

The extension uses Pi's host-provided SDK packages. Pi is distributed under the
MIT license:

https://github.com/earendil-works/pi

## pi-claude-bridge (experimental dependency)

The opt-in Claude Code backend initializes pi-claude-bridge 0.9.1, authored by
Eli Dickinson and distributed under the MIT license:

https://github.com/elidickinson/pi-claude-bridge

Its transitive dependencies include Anthropic's Claude Agent SDK and its
platform-specific Claude Code runtime. Those components retain their own license
and service terms; OptChat's MIT license does not relicense them. See the SDK's
README and license notices:

https://github.com/anthropics/claude-agent-sdk-typescript
