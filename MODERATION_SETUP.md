# ClipNow moderation setup

The moderation code is split into two layers:

- `moderation.js` blocks hard language in the browser and keeps comments relatively lenient.
- `supabase_moderation.sql` adds a database-side backstop for usernames, display names, bios, clip titles/descriptions and comments.
- `supabase/functions/moderate-media/index.ts` checks uploaded thumbnails and representative video frames before the upload is stored.

## 1. Run the database moderation SQL

Open the Supabase SQL Editor for the ClipNow project and run:

`supabase_moderation.sql`

Do not disable RLS. The trigger is only a validation backstop.

## 2. Configure media moderation

The media checker uses the OpenAI Moderations API through a Supabase Edge Function. The moderation endpoint supports text and image inputs, including base64 image data, and the current function uses `omni-moderation-latest`.

Create an OpenAI API key and store it as a Supabase Edge Function secret named:

`OPENAI_API_KEY`

Never put this key in `app.js`, `moderation.js`, HTML, GitHub Pages, or any browser code.

In the Supabase Dashboard, go to Edge Functions -> Secrets and add `OPENAI_API_KEY`, or use the Supabase CLI:

```bash
supabase secrets set OPENAI_API_KEY=your_key_here
```

## 3. Deploy the Edge Function

From the project folder, deploy the function:

```bash
supabase functions deploy moderate-media
```

The browser already calls it with `supabase.functions.invoke("moderate-media", ...)`, so no frontend URL or secret is needed.

## What gets blocked

### Usernames / handles / display names

Strict filtering. Strong profanity, explicit sexual terms, slurs and graphic-violence terms are blocked. Even ordinary swear words are not allowed in usernames/handles.

### Bios / clip titles / descriptions

Strong profanity, explicit sexual language, slurs and graphic-violence terms are blocked. Ordinary casual swearing is not treated the same as hard language.

### Comments

More lenient. Ordinary swearing can stay, while hard profanity, slurs, explicit sexual terms, threats/self-harm phrases and graphic-violence terms are blocked.

### Thumbnails / videos

The upload is checked before the media is stored. Custom thumbnails are checked directly. Videos have representative frames extracted in the browser and checked for sexual, sexual-minors, violence/graphic, self-harm and hateful imagery.

The video check is intentionally a representative-frame scan rather than an expensive frame-by-frame scan, so it improves safety without making every upload excessively slow. It is not a mathematical guarantee that every frame of a long video is safe.
