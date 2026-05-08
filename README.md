# Noleggio Pro — Backend

Orchestratore serverless tra GoHighLevel e Vapi, deployato su Vercel.

## Architettura

```
GHL (form submit) ──▶ /api/webhook/quiz-submitted   ──▶ (futuro) Vapi call
Vapi (call ended)  ──▶ /api/webhook/vapi-call-ended  ──▶ (futuro) GHL update
Vapi (live score)  ──▶ /api/webhook/score-update     ──▶ (futuro) real-time scoring
```

## Endpoint

| Metodo | Path | Trigger |
|--------|------|---------|
| POST | `/api/webhook/quiz-submitted` | GHL — lead compila il form |
| POST | `/api/webhook/vapi-call-ended` | Vapi — chiamata di Sara terminata |
| POST | `/api/webhook/score-update` | Vapi — score in tempo reale (dal giorno 11) |

## Setup locale

1. Clona il repo
2. Installa le dipendenze:
   ```bash
   npm install
   ```
3. Copia il template delle variabili d'ambiente:
   ```bash
   cp .env.local.example .env.local
   ```
4. Compila `.env.local` con le tue credenziali
5. Avvia il server di sviluppo Vercel:
   ```bash
   npm run dev
   ```

## Variabili d'ambiente

| Variabile | Descrizione |
|-----------|-------------|
| `GHL_API_KEY` | API key di GoHighLevel |
| `GHL_LOCATION_ID` | ID della location GHL |
| `VAPI_PRIVATE_KEY` | Chiave privata Vapi |
| `VAPI_PHONE_NUMBER_ID` | ID numero di telefono Vapi |
| `VAPI_ASSISTANT_ID` | ID assistente Vapi (Sara) |

## Deploy su Vercel

1. Importa il repo su [vercel.com](https://vercel.com)
2. Aggiungi le variabili d'ambiente nel pannello Vercel (Settings → Environment Variables)
3. Ogni push su `main` fa deploy automatico
