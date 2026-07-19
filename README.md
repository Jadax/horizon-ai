# Horizon AI 2.0

Self-hosted premium vertical-video automation with mandatory quality gates,
TTS-grounded editing, finished long-form clips, publish packages for YouTube,
TikTok, Instagram, and LinkedIn, affiliate insertion, and weekly Bayesian
learning. YouTube supports direct scheduling; other platforms remain honest
package-mode exports until their official posting credentials are configured.

Generated captions and edits use transcription timestamps from the synthesized
voiceover. Jobs below 85/100 or above 50ms subtitle precision are rejected.

## Quick Start

```bash
# 1. Clone this repo
git clone https://github.com/yourusername/horizon-ai.git
cd horizon-ai

# 2. Run setup (clones TTS & Render API)
chmod +x setup.sh
./setup.sh

# 3. Edit .env with your API keys
nano .env

# 4. Start locally (for testing)
npm start
