# Josh's voice clone

Builds a Professional Voice Clone of Josh (with his consent) for Ask Josh, from his own solo videos.

1. **Get the audio.** Best: the original exports from Josh's editor. Otherwise download these solo videos
   (Josh talking alone; interviews, discussions, cold-call recordings and vlogs are left out so no other voice
   gets in), about 4 hours in total, from his channel (youtube.com/channel/UCaJNq5_e7ognPLRqS6n-gCA):

   kAjMF9I6T3Q · F9uClunN_-0 · qAJVHZF_jVM · dqIJDaRZ3J4 · BLxqh2LCQVI · Z934g1J0APc · lYPDVA3TRnk ·
   6RjBttl1GDk · KVLw18DTT4M · RmJNxWD3UV4 · DPXMqS2vucM · N5-b-kOUH_4 · a1BJN7VzAYY · 4gkSCOtnNWw

2. **Clean it:** `python3 prepare.py <folder of videos> clips --minutes 120` (needs ffmpeg). Mono 44.1 kHz WAV,
   intros and outros trimmed, long silences cut, -18 LUFS, 3-6 minute clips, 2 hours by default.
3. **Clone it:** with an ElevenLabs key that has voice permissions (Creator plan or higher),
   `ELEVENLABS_API_KEY=... python3 clone.py create clips`.
4. **Josh verifies** it's his voice: in the ElevenLabs app (Voices → My voices → Josh Li), or
   `python3 clone.py captcha <voice_id>` then `python3 clone.py verify <voice_id> <his recording>`.
5. **Train:** `python3 clone.py train <voice_id>` (a few hours; `python3 clone.py status <voice_id>`).
6. **Use it:** `npx wrangler secret put JOSH_VOICE_ID` with the voice_id, then tune it in Ask Josh → Voice.
