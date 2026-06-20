We’re going to create a very lightweight iMessage \<\> Spotify app called Rotation with the following goals:

1. Helping users discover new music  
   1. This can happen either proactively \- ie. every week we text them a playlist with 50 new songs we think they’d like OR  
   2. In response to a prompt \- (more details below for one usecase) or ie “give me more songs like the ones on XX playlist” “give me more songs like the ones I have liked from YY artist” “I’m really into ZZ give me more from this genre based on what I have liked” “look through my liked songs and give me 200 more I’d fw”  
2. Help users create on demand playlists  
   1. A user texts with what they’re doing ie. “I’m going for a morning run” “I’m about to hit the gym” “I’m low energy today and need to be hyped up” “I need to lock in on this repo I’m coding/essay I’m writing.” “I’m with a girl and need something to set the mood” \~ Rotation understands your usual preferences / what your into a few ways:  
      1. It can imply a lot based on current likes / playlists \~ it needs to store all of this some way in Convex  
      2. If it’s unsure it can send a multiple choice poll through iMessage  
      3. If it’s novel it chooses the general genre then finds specific songs the user has liked / on a playlist that fit it well  
      4. It knows from previous context what users like to listen to while doing certain things \- if it doesn’t know it guesses / sends poll  
      5. In certain situations it may make sense to put the user on new music here… same scenario as \#1  
      6. For more context, it can text the user when they are “jamming out” (seeing through Spotify API they are in a listening session over 30m) and ask what they are doing if it can’t be implied by the name of the playlist and they haven’t already asked you to make this playlist. It also can categorize in Convex overall preferences based on names of playlists.

Let’s use Gemini 3.5 Flash for EVERYTHING here. Texting, choosing songs, etc. Let me know what you need to setup the Spotify API. The Gemini API key is AQ.Ab8RN6LEeRaCjkQxzLzKRiAQmRm8Yy8ReZ4k2Y\_GSEmpZHlgqw. The personality should be fun and match how the user talks; the occasional emoji, abbreviation, always texting in lowercase, but not overdoing it. Look at how Poke talks. All the tool calls we need should be built in, the agent should never need to reach \- we should have a stable but not overwhelming / overpowering architecture. 

$ npm create spectrum-project@latest rotation \-- \--providers imessage \~ PROJECT\_ID=dd003948-3c88-4641-bec0-22b0c400f024

PROJECT\_SECRET=gNcfMy2EW2dfAmZOxiAIeP9VOdPrZZZu7TK6aH6Y90s

Let me know what questions you have. 