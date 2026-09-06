import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 21 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'strict semantic duplicate rules',
  "      'Bei Korrespondenten, Firmen und Marken Eigennamen NICHT übersetzen. Dort nur Schreibvarianten, Abkürzungen oder offensichtliche Doppelanlagen gruppieren und als suggestedName den offiziellen bzw. saubersten vorhandenen Namen wählen.',",
  [
    "      'Bei Korrespondenten, Firmen und Marken Eigennamen NICHT übersetzen.',",
    "      'KORRESPONDENTEN EXTREM STRENG: Gruppiere nur, wenn es dieselbe reale juristische oder natürliche Person bzw. dieselbe Organisation ist. Thematische Nähe, gleiche Branche, gleiche Sendungsart, gleiche Behörde/Portal-Beziehung oder Konkurrenz reicht NIE.',",
    "      'NEGATIVBEISPIELE: DPD Deutschland GmbH und DHL sind NICHT gleich. Finanzamt und ELSTER sind NICHT gleich. ELSTER ist ein Portal/System und kein Synonym für ein Finanzamt.',",
    "      'Unterschiedliche Rechtsformen können unterschiedliche Rechtsträger bedeuten. GmbH und GmbH & Co. KG NICHT automatisch zusammenführen. Nur triviale Schreibweisen derselben Rechtsform wie GmbH vs. G.m.b.H. dürfen als Dublette gelten.',",
    "      'Bei Korrespondenten soll im Zweifel KEINE Gruppe erzeugt werden. Präzision ist wichtiger als Vollständigkeit.',"
  ].join('\n')
);

replaceOnce(
  'strict assistant cleanup rule',
  "    'Bei Metadaten-Aufräumvorschlägen bevorzuge für Dokumenttypen und thematische Tags natürliche deutsche kanonische Namen; englische Synonyme sollen zu passenden deutschen Namen normalisiert werden. Eigennamen von Firmen/Marken nicht übersetzen.',",
  [
    "    'Bei Metadaten-Aufräumvorschlägen bevorzuge für Dokumenttypen und thematische Tags natürliche deutsche kanonische Namen; englische Synonyme sollen zu passenden deutschen Namen normalisiert werden. Eigennamen von Firmen/Marken nicht übersetzen.',",
    "    'Korrespondenten nur als Dublette behandeln, wenn sie dieselbe reale Organisation/Person sind. DPD ist nicht DHL; Finanzamt ist nicht ELSTER; unterschiedliche Rechtsformen nicht automatisch mergen.',"
  ].join('\n')
);

await writeFile(file, source);
