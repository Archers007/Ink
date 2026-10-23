// The engine features the compiler still needs, each tied to the rulebook section that defines the mechanic. The learn
// loop (scripts/learn.mjs --features) sorts every unrunnable ability into these by its text and ranks them by how many
// cards building the feature would finish — so the next thing to build is picked by the cards, and built to the rule.
//   id     feature            cr  the CR section to build it to       rx  card text that needs it
//   build  where it goes (the class / engine hook to add or extend)
export const FEATURES = [
  { id: 'opponentDecides', cr: '6.1.4', build: 'effects/oppChoose.js + Prompter: the other player answers ("unless their player pays", "if they don\'t", "chooses YES! or NO!")',
    rx: /\bunless (?:their|that character's) player\b|\bif they don't\b|\bwho doesn't\b|\bchooses YES\b|\bchosen opponent chooses one\b|\bthey may (?:put|play)\b|\btheir player may\b/i },
  { id: 'playFromZone', cr: '4.3', build: 'H.play: a source zone other than hand (discard, under, inkwell, revealed) for one card or for a duration',
    rx: /\bplay (?:it|her|him|them|this (?:card|character)|that (?:character|song|action|card)|characters|those characters|an? .+?) (?:again )?from (?:your discard|under|there|their discard)|\bplay it as if it were in your hand\b|\byou may play it\b|\bplay characters from\b|\bfrom there for free\b|\bplay her and\b/i },
  { id: 'underCards', cr: '8.4', build: 'zones: cards under a card as a group ("for each card under him", "put … facedown under", Boost triggers)',
    rx: /\bunder (?:him|her|them|it|this (?:item|location|character))\b|\bfacedown under\b|\bwith Boost\b|\bBoost ability\b|\bwere under\b|\bfrom under\b/i },
  { id: 'deckOrder', cr: '7.2.3', build: 'effects/deck.js: put N / any number / all from a zone on the top or bottom of a deck in any order',
    rx: /\b(?:on the (?:bottom|top) of (?:your|their|their players') decks?)\b.*\bin any order\b|\bput \d+ .+ on the bottom of\b/i },
  { id: 'costRules', cr: '1.5', build: 'Static cost mods for kinds of play: "pay N more", "to shift", "using Shift", "first action each turn", "for free" for a name',
    rx: /\bpays? \d+ \{ink\} more\b|\bless to shift\b|\bcharacter you shift\b|\busing (?:her|his|their) Shift\b|\bfirst action you play\b|\bplay items named .+ for free\b|\bless to move\b|\bfor free instead\b|\bfor free\. If you do\b/i },
  { id: 'moveDamage', cr: '1.9.2', build: 'effects/damage.js MoveDamage: "move all / up to N damage (counters) from … to …"',
    rx: /\bmove (?:all|up to \d+) damage\b/i },
  { id: 'abilityLoss', cr: '6.6', build: 'mods: lose an ability / keyword, and "can\'t gain" a keyword (a static block checked when keywords are added)',
    rx: /\bcan't gain (?:Evasive|Rush|Ward|\w+)\b|\blose the .+ ability\b|\blose (?:Rush|Evasive|Ward)\b/i },
  { id: 'statFloor', cr: '6.6.4', build: 'effStr: a floor at the printed value ("can\'t be reduced below their printed value")',
    rx: /\bcan't be reduced below\b/i },
  { id: 'targeting', cr: '8.15', build: 'Prompter.targets: forced / forbidden choices ("must choose this character", Ward for items) and "whenever an opponent chooses this character"',
    rx: /\bmust choose this character\b|\bcan't choose your items\b|\bchooses this character for an action\b|\bchosen for an action or an item's ability\b|\bitems gain Ward\b/i },
  { id: 'handSize', cr: '7.3', build: 'effects: draw / discard until a hand size ("until they have 3", "more than 2 cards in their hand")',
    rx: /\buntil (?:they|you) have \d+\b|\bmore than \d+ cards in their hand\b|\bfewer than \d+ cards in their hand\b|\bcards in (?:your )?opponents' hands\b/i },
  { id: 'random', cr: '6.7', build: 'engine rand: "at random" for discard / inkwell / hand picks',
    rx: /\bat random\b/i },
  { id: 'players', cr: '1.3', build: 'phrases/player.js: "any number of players", "you and another chosen player", "each player reveals …"',
    rx: /\bany number of players\b|\byou and another chosen player\b|\beach player (?:reveals|shuffles|may reveal|chooses \d)\b|\bfor each opposing player\b|\bif you have 2 or more opponents\b/i },
  { id: 'turnHistory', cr: '6.2.7', build: 'conditions/exists.js Did + s.turnLog: "the first time … each turn", "banished in a challenge this turn", "who was challenged this turn"',
    rx: /\bthe first time\b|\bfor the first time each turn\b|\bbanished in a challenge this turn\b|\bwho was challenged\b|\btwice during your turn\b/i },
  { id: 'newTriggers', cr: '6.2', build: 'triggers/: draw, discard, mill, enters exerted, Boost, move from a location, an action dealing damage',
    rx: /\bwhenever (?:you|they|an opponent) draws? a card\b|\bwhenever your opponent discards\b|\binto your discard from your deck\b|\benters play exerted, you may\b|\bwhenever one of your actions deals damage\b|\bfrom a location\b|\bwhenever you return\b|\bwhenever another character is played\b|\bwhenever you remove damage\b/i },
  { id: 'amounts', cr: '6.7', build: 'phrases/amount.js: counted amounts ("count the number of …", "equal to the {X} of", "different ink type", "highest cost", "different name")',
    rx: /\bcount the number\b|\bequal to the \{\w+\} of\b|\bdifferent ink types?\b|\bhighest cost\b|\bdifferent name\b|\b\{willpower\} to another chosen character's \{strength\}|\+\{strength\} equal\b|\btotal \{strength\}\b|\bdamage total\b/i },
  { id: 'sequence', cr: '6.7.3', build: 'compiler: "then", "repeat this effect", "after the challenge", "the next time they challenge" — steps that wait for a later event',
    rx: /\brepeat this effect\b|\bafter the challenge\b|\bthe next time they challenge\b|\breveal cards from the top of your deck until\b/i },
];
export function featureOf(text) {
  for (const f of FEATURES) if (f.rx.test(text)) return f;
  return null;
}
