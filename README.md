# Aktivko

A free browser version of the classic team party game where you **draw**, **describe** or **act out** a word while your team races to guess it.

**Play:** https://shelbyaideals.github.io/activity-online/

## Two ways to play

- **One phone.** Sit together and pass the phone around, like the board game. The phone keeps the board, deals the words, runs the timer and gives you a drawing pad.
- **Online room.** One person creates a room and sends the link. Everyone plays on their own phone: the performer sees the word, drawings appear live on every screen, and guesses can be typed (an exact match scores automatically). For describing and acting, get on a video call.

No sign-up, no server, no ads. Words in English and Slovenian (450 each), plus your own words if you like.

## Rules

1. Split into 2 to 4 teams. Teams take turns: one player performs, their own team guesses.
2. The field your team stands on decides how you perform: draw, describe or act it out.
3. Pick a card worth 3, 4 or 5. Harder words move you further.
4. Guess the word before the time runs out and your team moves that many fields. If not, you stay put.
5. On star fields every team guesses, and the team that gets it first moves.
6. The first team to reach the finish wins.

## How it works

It is a static site: HTML, CSS and plain JavaScript modules, no build step.

- `js/engine.js` holds the rules as a pure state machine, shared by local games and online rooms.
- Online rooms are peer to peer. The host's browser keeps the game state; other players connect to it directly over WebRTC using [PeerJS](https://peerjs.com/) and its free public signalling server. Each player only receives what they are allowed to see (the word goes to the performer alone). The host should keep their tab open; a reload reconnects everyone.
- `js/words.js` is the word deck. Add or change words there.

## Run locally

```sh
npm start        # serves the folder on http://localhost:8080
npm test         # rule and state machine tests (Node 20+)
npm run e2e      # browser test: local games plus a 4-player online room
```

The browser test needs `npm install` and a Chromium (`npx playwright install chromium`, or set `CHROME_PATH`). Set `BASE` to test another address, such as the live site.

Any static file server works, since the pages use ES modules and can't be opened straight from the file system.

## Credits

Inspired by the board game *Activity*. This is an independent fan project with its own words and design, and is not affiliated with or endorsed by Piatnik.

MIT licence.
