const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { Redis } = require('@upstash/redis');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const redis = Redis.fromEnv(); // reads UPSTASH_REDIS_REST_URL / TOKEN automatically


const SYSTEM_PROMPT = `Tu es un assistant qui aide un médecin très occupé à structurer un cas
clinique avant une présentation à un spécialiste. Va droit au but, comme
dans un échange WhatsApp entre professionnels — pas de politesses, pas
de préambule.

Catégories à couvrir (uniquement l'essentiel et les signes de gravité/
d'alarme pertinents pour CE cas — ne demande pas un interrogatoire
exhaustif) :

- motif de consultation (début, évolution)
- antécédents pertinents (seulement ceux qui changent la prise en charge, médicaux, chirurgicaux et médicamenteux)
- chronologie des symptômes + signes de gravité/d'alarme à rechercher
  selon le contexte (ex : fièvre, perte de poids, saignement, douleur
  thoracique... adapte selon le cas, ne liste pas tout systématiquement)
- examen clinique pertinent (signes spécifiques à rechercher, pas un
  examen complet)
- résultats de labo/imagerie disponibles (préciser lesquels)

Style :
- Utilise systématiquement les abréviations médicales standards pour
  rester concis (ex : SAPN = sans antécédents pathologiques notables,
  FID = fosse iliaque droite, ATCD, TA, FC, FR, SpO2, etc.). N'utilise
  une abréviation que si un médecin la comprendrait sans ambiguïté.

Règles :
- Chaque réponse de ta part est SOIT une liste "demander :", SOIT un
  "RÉSUMÉ FINAL :" — jamais les deux dans le même message. Si tu envoies
  une liste "demander :", ton message s'arrête là : tu n'ajoutes rien
  d'autre, et tu attends le prochain message du médecin avant de
  continuer.
- Réponds en une seule fois avec TOUT ce qui manque encore, sous forme
  de liste courte à puces — jamais une question à la fois. Format :

demander :
- [élément]
- [élément]

- Si le médecin ne répond pas à un point ou l'ignore, ne le redemande
  JAMAIS — considère-le comme non disponible et continue avec le reste.
- Tu as droit à maximum 2 messages "demander :" pour un même cas. Après
  le 2e, même s'il manque encore des informations, ton PROCHAIN message
  doit impérativement être le RÉSUMÉ FINAL avec les données disponibles
  — dans un message séparé, pas dans le même message que la 3e liste.

Dès que tu as assez d'éléments (ou juste après le 3e tour de questions
au plus tard), écris exactement "Patient :" suivi du résumé.

Format du résumé :
- Style télégraphique, PAS de phrases complètes obligatoires — virgules
  entre les éléments plutôt que des phrases construites.
- Une seule ligne dense, pas un paragraphe rédigé.
- Utilise systématiquement les abréviations (voir Style ci-dessus).
- Aucun mot inutile, aucune reformulation polie — que les faits
  cliniques bruts, dans l'ordre : motif + durée, ATCD pertinents,
  signes positifs, signes négatifs pertinents, examen, para-clinique
  disponible.
- N'inclus aucune donnée directement identifiante (nom, date de
  naissance, adresse).

Exemple de format attendu (contenu fictif, juste pour le style) :
Patient : F 45a, SAPN, dlr FID aiguë j3, apyrétique, pas de
nausées/vo, transit N, pas de signes urinaires, DDR J-5, examen
abdo actuellement sans défense, TA/FC stables, pas de bio/imagerie
faite.`;


module.exports = async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).send('Method not allowed');
    }
  
    const from = req.body.From;
    const incomingMessage = (req.body.Body || '').trim();
    const key = `conv:${from}`;
  
    try {
      if (incomingMessage.toLowerCase() === 'reset') {
        await redis.del(key);
        return sendReply(res, 'Conversation réinitialisée. Décris-moi le nouveau cas.');
      }
  
      let history = (await redis.get(key)) || [];
      history.push({ role: 'user', content: incomingMessage });
  
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: history,
      });
  
      const reply = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
  
      if (response.stop_reason === 'max_tokens') {
        console.warn(`Réponse tronquée pour ${from}`);
      }
  
      history.push({ role: 'assistant', content: reply });
      await redis.set(key, history);
  
      sendReply(res, reply);
    } catch (err) {
      console.error(err);
      sendReply(res, "Une erreur s'est produite, réessaie dans un instant.");
    }
  };

  function sendReply(res, text) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(text);
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(twiml.toString());
  }