# CV Impact Architect

A production-ready Next.js AI chat tool that helps improve the "Doświadczenie" (Experience) section of Polish CVs. Built with App Router, TypeScript, and Tailwind CSS.

## Features

- **Mobile-first AI chat interface** - Claude-like chat experience optimized for all devices
- **Smart agent workflow** - Audit TOP 3 roles → select → interview → BEFORE/AFTER rewrite
- **Context management** - Pinned CV text with sliding window for long conversations
- **Polish language support** - All interactions in Polish
- **React Markdown rendering** - Beautiful formatting for assistant responses
- **Sample data** - Quick demo with "Try sample" button

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure OpenAI API:**

   Open `.env` and add your OpenAI API key:
   ```
   OPENAI_API_KEY=sk-your-actual-api-key-here
   OPENAI_MODEL=gpt-4o-mini
   ```

   Get your API key from: https://platform.openai.com/api-keys

3. **Run the development server:**
   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000)

4. **Build for production:**
   ```bash
   npm run build
   npm start
   ```

## How It Works

### User Flow

1. User pastes their CV Experience section (or clicks "Try sample")
2. AI analyzes and provides an audit of TOP 3 roles
3. User selects which role to improve (1, 2, or 3)
4. AI conducts a short interview (2-4 questions) to extract metrics
5. AI provides BEFORE/AFTER with two rewrite variants (A/B)
6. User can iterate on more roles or start a new chat

### Technical Architecture

**Frontend:**
- `components/chat-interface.tsx` - Main chat UI with message rendering
- `lib/prompts.ts` - Embedded system and context prompts (no runtime fs reads)

**Backend:**
- `app/api/chat/route.ts` - OpenAI Chat Completions API integration
- Context strategy: System prompts → CV text (pinned) → Last 10 messages

**Prompts:**
- `prompts/system.md` - Core agent instructions and workflow
- `prompts/context.md` - Onboarding message and additional rules

## Agent Rules

The AI follows strict rules:
- **Scope:** ONLY Experience/Doświadczenie section (redirects all other requests)
- **Language:** All outputs in Polish
- **No invented data:** Never adds metrics or facts not provided by user
- **Handles:** "Nie pamiętam" (offers ranges/verification paths), "lanie wody" (challenges generics), data anonymization
- **Format:** Plain text responses, no JSON or code fences (except BEFORE/AFTER blocks)

## Key Components

- **Onboarding:** First message explains the workflow
- **New Chat:** Clears history and resets CV text
- **Try Sample:** Pre-fills input with sample Experience text
- **Context pinning:** Original CV text is always included in API requests
- **Sliding window:** Last 10 messages to manage token usage

## Environment Variables

```bash
# Required
OPENAI_API_KEY=your-openai-api-key-here

# Optional (defaults shown)
OPENAI_MODEL=gpt-4o-mini

# Supabase (not used in MVP but available)
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

## Demo for CEO

Perfect for showing:
1. **Speed:** "Try sample" → instant audit → select role → 2 questions → polished rewrite
2. **Quality:** BEFORE/AFTER shows dramatic improvement
3. **Intelligence:** AI asks smart questions, never invents data
4. **Polish UX:** Clean, mobile-first, professional

## File Structure

```
/app
  /api/chat/route.ts       # OpenAI API integration
  globals.css              # Tailwind + custom styles
  layout.tsx               # Root layout with metadata
  page.tsx                 # Main page (renders ChatInterface)
/components
  /ui/                     # shadcn/ui components
  chat-interface.tsx       # Main chat UI component
/lib
  prompts.ts               # Embedded system & context prompts
  utils.ts                 # Utility functions
/prompts
  system.md                # Agent system prompt (reference)
  context.md               # Agent context prompt (reference)
```

## Notes

- No PDF upload or preview drawer (keeping it minimal for MVP)
- No animations or fancy chips/buttons (focus on stability)
- Runtime-safe: Prompts embedded in code, not read from files
- Built to impress in CEO demo: simple, fast, effective

## License

MIT
