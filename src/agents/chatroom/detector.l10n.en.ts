import type { ChatRoomDetectorL10n } from "./detector.l10n.types.js";

/**
 * Chatroom Detector — English keyword/regex patterns
 *
 * @module agents/chatroom/detector.l10n.en
 */
export const CHATROOM_DETECTOR_EN: ChatRoomDetectorL10n = {
  // ── Tri-summon patterns (all participants) ──
  triSummonPatterns: [
    /all\s*three.*(?:together|at\s*once|gather|assemble)/i,
    /three.*concubines?/i,
    /(?:everyone|all\s*(?:of\s*you|concubines?)).*(?:together|at\s*once).*(?:answer|speak|chat|come)/i,
    /(?:all|every)\s*concubines?/i,
    /all\s*three.*(?:serve|attend)/i,
    /(?:together|all).*(?:serve|attend)/i,
    /(?:girls|ladies|sisters).*(?:gather|assemble|come|together)/i,
    /you\s*three/i,
    /all\s*three\s*of\s*you/i,
    /open\s*chatroom/i,
    /concubine\s*chatroom/i,
    /@(?:all|everyone|everybody)/i,
    // P119b: Direct keyword chatroom activation
    /chatroom\s*mode/i,
    /chat\s*mode/i,
    /casual\s*(?:chat|talk)\s*mode/i,
    /(?:start|enter|open|launch|activate).*(?:chatroom|chat\s*mode|casual\s*chat)/i,
    /(?:let'?s|start|begin).*(?:casual\s*chat|group\s*chat|chatting)/i,
    /(?:keep\s*me\s*company|chat\s*with\s*me|talk\s*to\s*me)/i,
    /(?:together|all\s*of\s*you).*(?:chat|talk|keep\s*me\s*company)/i,
  ],

  // ── Review / critique patterns ──
  reviewPatterns: [
    /(?:you\s*(?:all|guys)|girls|ladies|sisters).*(?:review|evaluate|comment|rate|judge|think\s*of)/i,
    /(?:each|mutual).*(?:review|evaluate|comment|critique)/i,
    /(?:your|each).*(?:opinion|take|thoughts)/i,
  ],

  // ── Free chat patterns ──
  freeChatPatterns: [
    /(?:you\s*(?:all|guys)|girls|ladies|sisters).*(?:chat|discuss|continue|talk)/i,
    /free.*(?:discussion|chat|talk)/i,
    /(?:you\s*(?:all|guys)).*continue/i,
  ],

  // ── Debate patterns ──
  debatePatterns: [
    /(?:debate|argue|discuss.*pros?\s*(?:and|&)\s*cons?|take\s*sides)/i,
    /(?:you\s*(?:all|guys)|girls|ladies|sisters).*debat/i,
  ],

  // ── Exit chatroom ──
  exitPatterns: [
    /(?:dismiss|close\s*chatroom|exit\s*chatroom|enough|leave|end\s*(?:chat|session))/i,
    /(?:only|just)\s*(?:want|need|talk\s*to|with).*(?:lina|demerzel|dolores)/i,
    /(?:alone|private|privately).*(?:with|talk|speak)/i,
  ],
};
