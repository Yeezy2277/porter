# Porter evals: cases to review

Two evals. Please read both lists and say yes, or tell me what to change. The gold answers are mine (written by hand, not copied from Claude's output); where an editor could reasonably disagree, the case accepts several answers.

## 1. Linking (53 cases)

Each WordPress author or term must be linked to the right existing entry, or become a new entry, or be skipped. Graded by code: the decision is correct when it's in the accepted list. Reported per kind and per difficulty, with retrieval recall (was the right entry even among the candidates?) separate from the decision.

By kind: author 19, category 13, tag 21. By difficulty: abbreviated 5, accents 3, ambiguous 3, destination 6, exact 4, meta 2, near-miss 6, no-match 4, semantic 20

| id | kind | source item | accepted answers | why it's hard |
|---|---|---|---|---|
| demo-author-2 | author | Ana Lucia Ortega — “Lisbon-based food writer. Markets, bakeries and the people behind them.” | link → Ana-Lucía Ortega | accents |
| demo-author-3 | author | Tom B. — “Ex mountain guide, writes about hut-to-hut walks and bad weather.” | link → Tom Brennan | near-miss |
| demo-author-4 | author | Mei Sato — “Night trains and timetables. Takes the photos too.” | link → Mei Sato | exact |
| demo-author-5 | author | Chidi O. — “Editor at large.” | link → Chidi Okafor | abbreviated |
| demo-author-6 | author | Northbound Staff (no bio) | link → Editorial Desk | semantic |
| demo-category-1 | category | Uncategorized | skip | meta |
| demo-category-10 | category | Eating Out | link → Food & Drink | semantic |
| demo-category-11 | category | Trekking | link → Hiking & Trails | semantic |
| demo-category-12 | category | Trains | link → Rail Travel | semantic |
| demo-category-13 | category | City Breaks | link → City Guides | semantic |
| demo-tag-100 | tag | Lisbon | link → Portugal | destination |
| demo-tag-101 | tag | pastries | link → Food & Drink | semantic |
| demo-tag-102 | tag | Alps | skip / link → Switzerland / link → Austria / link → France | ambiguous |
| demo-tag-103 | tag | mountain huts | link → Hiking & Trails | semantic |
| demo-tag-104 | tag | night train | link → Rail Travel | near-miss |
| demo-tag-105 | tag | Interrail | link → Rail Travel | semantic |
| demo-tag-106 | tag | cheap eats | link → Budget Travel / link → Food & Drink | ambiguous |
| demo-tag-107 | tag | slow travel | link → Sustainable Travel | semantic |
| demo-tag-108 | tag | Kyoto | link → Japan | destination |
| demo-tag-109 | tag | markets | link → Markets & Shopping / link → Food & Drink | ambiguous |
| demo-tag-110 | tag | Porto | link → Portugal | destination |
| x-author-a-ortega | author | A. Ortega — “Writes about Lisbon's bakeries and food markets.” | link → Ana-Lucía Ortega | near-miss |
| x-author-ana-o | author | Ana O. — “Picture desk: chooses the photos and writes the captions.” | link → Ana Ortiz | near-miss |
| x-author-t-brenner | author | T. Brenner — “Reviews Vienna's coffee houses and wine bars.” | link → Tomas Brenner | near-miss |
| x-author-tom-brennan | author | Tom Brennan (no bio) | link → Tom Brennan | exact |
| x-author-kenji-s | author | Kenji S. — “Hotels and buildings in Tokyo.” | link → Kenji Satoh | abbreviated |
| x-author-mei | author | Mei — “Trains at night, and the photos taken from them.” | link → Mei Sato | abbreviated |
| x-author-petra-novak | author | Petra Novak — “Hostels and rail passes on a budget.” | link → Petra Novák | accents |
| x-author-j-ferreira | author | J. Ferreira — “From Porto. Port wine and the Douro.” | link → João Ferreira | abbreviated |
| x-author-editorial-team | author | Editorial Team (no bio) | link → Editorial Desk | semantic |
| x-author-laura-kim | author | Laura Kim — “Writes about street food in Seoul.” | new | no-match |
| x-author-siobhan | author | Siobhan O Connell — “Coastal walks in Ireland.” | link → Siobhan O'Connell | accents |
| x-author-guest-writer | author | Guest Writer — “Occasional pieces by outside writers.” | link → Guest Contributor | semantic |
| x-author-rania | author | Rania — “Desert routes and souks.” | link → Rania Haddad | abbreviated |
| x-author-chris-okafor | author | Chris Okafor — “Sports photographer covering football.” | new | near-miss |
| x-category-food | category | Food | link → Food & Drink | exact |
| x-category-wine | category | Wine | link → Wine Regions | semantic |
| x-category-cycling-tours | category | Cycling Tours | link → Cycling | semantic |
| x-category-ski | category | Ski | link → Winter Sports | semantic |
| x-category-island-hopping | category | Island Hopping | link → Ferries & Islands | semantic |
| x-category-kids | category | Kids & Family | link → Family Travel | semantic |
| x-category-podcasts | category | Podcasts | new / skip | no-match |
| x-category-news | category | News | new / skip | no-match |
| x-tag-espresso | tag | espresso | link → Coffee Culture | semantic |
| x-tag-tokyo | tag | Tokyo | link → Japan | destination |
| x-tag-provence | tag | Provence | link → France | destination |
| x-tag-hostels | tag | hostels | link → Hostels / link → Budget Travel | exact |
| x-tag-carnival | tag | carnival | link → Festivals & Events | semantic |
| x-tag-photo-tips | tag | photography tips | link → Travel Photography | semantic |
| x-tag-sunsets | tag | sunsets | skip | no-match |
| x-tag-best-of-2019 | tag | best of 2019 | skip | meta |
| x-tag-vineyards | tag | vineyards | link → Wine Regions | semantic |
| x-tag-dolomites | tag | Dolomites | link → Italy / skip | destination |

## 2. Agent (19 posts)

For each post the agent runs end to end (the real loop and tools) on the approved mapping and links. Graded per post:

- **By code:** submitted (not flagged or stopped); every field it wrote passes the field's rules; no name or number missing from the source (checked again on the final draft); region in the accepted list; turns and cost.
- **By a judge (Claude Haiku 5.5), only on summary and SEO description, one yes/no per criterion:** faithful (says nothing the post doesn't), specific (about this article, not generic travel copy), plain (no hype or clickbait), fit for purpose (a summary says what the reader gets; an SEO description is one sentence that makes a searcher click). Calibrated against your labels before its numbers count.

| post | title | accepted region | trap |
|---|---|---|---|
| 1201 (demo) | The Best Pastéis de Nata in Lisbon (2019 Edition) | Europe | prices and a year in the text |
| 1202 (demo) | Hut to Hut in the Alps: A First-Timer’s Guide | Europe | SEO description written from scratch |
| 1203 (demo) | Four Days Above Chamonix | Europe | empty excerpt; 'four huts' vs three in the table |
| 1204 (demo) | Vienna to Venice by Sleeper Train | Europe | only region left to write |
| 1205 (demo) | Interrail on a Budget: 10 Things We Learned | Europe | excerpt under 40 characters; author is a new entry |
| 1206 (demo) | Kyoto Without the Crowds | Asia | publish time 23:00 UTC is the next day locally |
| 1207 (demo) | Porto’s Bolhão Market Reopens | Europe | empty SEO description |
| 1208 (demo) | Why We Stopped Flying Short-Haul | empty / Europe | editor's note with no single place |
| 1209 (demo) | A Guide to Lisbon’s Markets | Europe | only region left to write |
| 1301 | Sydney Harbour by Ferry | Oceania | no exact price in the text: a summary must not invent one |
| 1302 | A Weekend in Mexico City | Americas | empty excerpt and SEO description: both fields written from scratch |
| 1303 | Marrakech’s Souks Without the Stress | Africa | excerpt under 40 characters: the summary must be rewritten, not copied |
| 1304 | How to Order Coffee in Vienna | Europe | German drink names: grounding must accept names that are in the text |
| 1305 | Packing for a Night Train | empty | no place at all: region should stay empty |
| 1306 | Could You Go From Lisbon to Tokyo by Train? | empty / Europe / Asia | spans continents: empty, Europe or Asia are all defensible |
| 1307 | The W Trek in Torres del Paine | Americas | numbers in the text (4–5 days, 80 km): a summary may use them, never change them |
| 1308 | Eating Well in Hanoi | Asia | very short excerpt; dish names must survive grounding |
| 1309 | Why We Don’t Rate Restaurants | empty | editor's note with no place: region empty; no invented numbers |
| 1310 | Table Mountain: Cable Car or On Foot? | Africa | Cape Town is not named: region must come from Table Mountain, not a guessed city |

The ten new posts are in `samples/evals/posts.json` (short, invented, written in the magazine's style).
