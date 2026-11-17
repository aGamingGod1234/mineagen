# Agent logo skins

The bundled branded agent PNGs are 512×512 Minecraft textures with the vanilla
64×64 UV layout preserved. The visible 8×8 head face therefore has a 64px raster
for the logo, while ordinary player and mob textures are not changed. The marks
are rasterized from the referenced online logo sources rather than redrawn as
approximate pixel-art silhouettes:

- [OpenAI Design Guidelines](https://openai.com/brand/)
- [OpenAI vector mark used for rasterization](https://github.com/simple-icons/simple-icons/blob/develop/icons/openai.svg)
- [Anthropic Claude](https://www.anthropic.com/claude)
- [Claude app icon source](https://claude.ai/images/claude_app_icon.png)
- [Claude vector mark](https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/claude-ai/default.svg)

Every logo gets a 56x56 raster inside the 64px face square with a 4px clear margin,
placed on the front face only. Codex agents wear the OpenAI skin, Claude agents
wear the Claude skin. Future providers without dedicated artwork share
the OpenAI skin. The dominant body swatches
use these reference anchors, with dark edge shading only for model readability:

These higher-resolution files are consumed by the mod's renderer. They are not
drop-in replacements for the vanilla skin-upload screen, which expects the
standard skin layout.

| Skin | Body / primary anchor |
| --- | --- |
| ChatGPT / OpenAI | `#10A37F` |
| Claude | `#D97757` |

These references remain attribution and design-reference links only. No external
asset is fetched during the build. Use of a company's marks may require permission
under that company's terms. The pixel approximations should not imply endorsement.

Only `brand_openai` and `brand_claude` ship, with four variants each. Model-family labels and transport codes remain separate from artwork, so changing a model does not select another skin family. Run `node scripts/generate-agent-skins.mjs --check` to verify the eight retained textures; `java scripts/GenerateAgentWaypointIcons.java` regenerates their locator faces.
