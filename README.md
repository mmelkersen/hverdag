# Hverdag

Ugens tilbud fra Netto, Føtex, 365discount og Rema 1000, en indkøbsseddel sorteret efter butik og afdeling, og daglig overvågning af prisen på blyfri 95.

- **Hjemmeside (telefon):** https://mmelkersen.github.io/hverdag/. Åbn i Safari, tryk Del og vælg *Føj til hjemmeskærm*.
- **Claude-version:** https://claude.ai/artifact/SWPvxQfLhqLdWrDHeGRWNg

## Filer

- `hverdag.html`: selve siden. Den samme fil bruges begge steder. I Claude læser den fra artefaktets database. På hjemmesiden læser den fra `site/data/` og gemmer indkøbssedlen på enheden.
- `hent-data.mjs`: henter data.
  - Tilbud: Tjek/eTilbudsavis-API'et.
  - Fast sortiment med mærker (Ø-mærket, Nøglehul …): Rema 1000's produkt-API.
  - Benzin: https://www.detkoster.dk/benzin/data.json (CC BY 4.0).
- `site/`: det, der udgives på GitHub Pages: `index.html` bygges fra `hverdag.html`, plus data, manifest, offline-cache og ikoner.
- `.github/workflows/opdater.yml`: kører hver morgen kl. 07:30 (sommertid). Den henter data, gemmer benzinhistorikken i repoet og udgiver siden.

## Kør lokalt

```
node hent-data.mjs --site      # alt
node hent-data.mjs fuel --site # kun benzin + genbyg index.html
```
