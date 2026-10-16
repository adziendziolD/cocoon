import { AsyncLocalStorage } from 'node:async_hooks';
import type { Language } from '@cocoon/protocol';

type Params = Record<string, string | number>;

/** Server-side messages shown to users (errors, activity log, setup checklist), in both UI languages. */
export const messages = {
  // errors
  'error.notFound': { de: '{what} {id} nicht gefunden', en: '{what} {id} not found' },
  'error.unauthorized': { de: 'Ungültiger oder fehlender Zugangs-Token', en: 'Invalid or missing access token' },
  'error.unknownMethod': { de: 'Unbekannte Methode {method}', en: 'Unknown method {method}' },
  'error.invalidParams': { de: 'Ungültige Eingabe: {details}', en: 'Invalid input: {details}' },
  'error.buildContextMissing': { de: 'Build-Verzeichnis {path} nicht gefunden', en: 'Build directory {path} not found' },
  'error.imageMissing': {
    de: 'Image „{image}“ ist nicht vorhanden – bitte zuerst bauen (Einstellungen → Sandbox-Standards).',
    en: 'Image "{image}" does not exist – please build it first (Settings → Sandbox defaults).',
  },
  'error.taskPublishFailed': {
    de: 'Die Änderungen konnten nicht hochgeladen werden – die Aufgabe bleibt in „Prüfen“ und die Sandbox bleibt erhalten: {error}',
    en: 'The changes could not be pushed – the task stays in "Review" and the sandbox is kept: {error}',
  },
  'error.portsUnavailable': {
    de: 'Ports nach außen freigeben geht derzeit nur mit Docker oder Podman (aktiv: {name}).',
    en: 'Opening ports to the outside currently needs Docker or Podman (active: {name}).',
  },
  'error.portNoNetwork': { de: 'Die Sandbox hat kein Netzwerk („Kein Netzwerk“) – ihre Ports lassen sich nicht freigeben.', en: 'The sandbox has no network ("No network") – its ports cannot be opened.' },
  'error.portShareDisabled': {
    de: 'Freigeben im Netzwerk ist ausgeschaltet (COCOON_PORTS_SHARE_BIND ist leer). Nutze die Vorschau.',
    en: 'Sharing on the network is turned off (COCOON_PORTS_SHARE_BIND is empty). Use the preview instead.',
  },
  'error.portNotOpen': { de: 'Port {port} ist nicht geöffnet.', en: 'Port {port} is not open.' },
  'error.portRangeFull': { de: 'Alle Host-Ports im Bereich {range} sind belegt. Schließe einen offenen Port.', en: 'All host ports in the range {range} are in use. Close an open port first.' },
  'error.workspaceKeyTaken': { de: 'Das Kürzel „{key}“ ist ungültig oder wird schon von einem anderen Workspace benutzt (2–6 Großbuchstaben/Ziffern).', en: 'The key "{key}" is invalid or already used by another workspace (2–6 capital letters/digits).' },
  'error.updateRunning': { de: 'Es läuft bereits ein Update.', en: 'An update is already running.' },
  'error.restartUnsupported': {
    de: 'CoCoon kann sich nicht selbst neu starten – bitte von Hand neu starten (mit „pnpm start“ gestartet, startet CoCoon selbst neu).',
    en: 'CoCoon cannot restart itself – please restart it by hand (when started with "pnpm start", CoCoon restarts itself).',
  },
  'update.upToDate': { de: 'CoCoon ist aktuell.', en: 'CoCoon is up to date.' },
  'update.blocked.notGit': {
    de: 'CoCoon ist nicht aus einem git-Klon installiert und kann sich nicht selbst aktualisieren.',
    en: 'CoCoon is not installed from a git clone and cannot update itself.',
  },
  'update.blocked.noUpstream': {
    de: 'Der aktuelle git-Branch folgt keinem Remote-Branch („git branch --set-upstream-to origin/main“).',
    en: 'The current git branch does not track a remote branch ("git branch --set-upstream-to origin/main").',
  },
  'update.blocked.dirty': {
    de: 'Im CoCoon-Ordner gibt es lokale Änderungen an Dateien – bitte erst committen oder verwerfen.',
    en: 'There are local changes to files in the CoCoon folder – please commit or discard them first.',
  },
  'update.blocked.diverged': {
    de: 'Lokale Commits und neue Commits im Remote-Branch – bitte von Hand zusammenführen („git pull“).',
    en: 'Local commits and new commits on the remote branch – please merge them by hand ("git pull").',
  },
  'error.timeout': { de: 'Befehl hat das Zeitlimit von {ms} ms überschritten', en: 'Command exceeded the time limit of {ms} ms' },
  'error.pathNotFound': { de: '{path} nicht gefunden', en: '{path} not found' },
  'error.exitCode': { de: 'Exit-Code {code}', en: 'exit code {code}' },
  'error.agentStartFailed': { de: 'Agent konnte nicht gestartet werden: {error}', en: 'Could not start the agent: {error}' },
  'error.agentExited': { de: 'Agent {id} ist beendet', en: 'Agent {id} has exited' },
  'error.unknownAgentKind': {
    de: 'Unbekannter Agent-Typ „{kind}“ (verfügbar: {available})',
    en: 'Unknown agent type "{kind}" (available: {available})',
  },
  'error.toolMissing': {
    de: '{tool} ist in dieser Sandbox nicht installiert – installiere es unter Einstellungen → Sandbox-Standards → Agent-Werkzeuge.',
    en: '{tool} is not installed in this sandbox – install it under Settings → Sandbox defaults → Agent tools.',
  },
  'error.adapterNoProviders': { de: '{agent} unterstützt keine eigenen API-Anbieter.', en: '{agent} does not support custom API providers.' },
  'error.providerIncompatible': {
    de: '{agent} kann „{provider}“ nicht nutzen: Der Anbieter spricht nur {apis}. Wähle einen anderen Agenten (z. B. OpenCode, Pi oder Qwen Code) oder einen passenden Anbieter.',
    en: '{agent} cannot use "{provider}": the provider only speaks {apis}. Pick another agent (e.g. OpenCode, Pi or Qwen Code) or a matching provider.',
  },
  'error.translationNeedsProxy': {
    de: '{agent} braucht für diesen Anbieter die API-Übersetzung von CoCoon. Dafür muss der Schutz für API-Keys aktiv sein und die Sandbox Netzwerkzugang haben.',
    en: '{agent} needs CoCoon\'s API translation for this provider. That requires the API key protection to be on and the sandbox to have network access.',
  },
  'error.modelRequired': {
    de: 'Für „{provider}“ ist kein Modell festgelegt. Wähle beim Start ein Modell oder trage eins beim Anbieter ein.',
    en: 'No model is set for "{provider}". Pick a model when starting or set one on the provider.',
  },
  'error.unknownProvider': { de: 'Unbekannter API-Anbieter „{id}“', en: 'Unknown API provider "{id}"' },
  'error.serviceNeedsContainers': { de: 'Von CoCoon verwaltete Dienste brauchen Docker oder Podman. Mit bubblewrap kannst du einen eigenen Server verbinden.', en: 'Services managed by CoCoon need Docker or Podman. With bubblewrap you can connect your own server.' },
  'error.serviceMockManagedOnly': { de: 'Mock-Dienste startet CoCoon selbst – ein externer Server ist dafür nicht vorgesehen.', en: 'CoCoon runs mock services itself – external servers are not supported for them.' },
  'error.serviceHostRequired': { de: 'Bitte die Adresse des Servers angeben.', en: 'Please enter the server address.' },
  'error.serviceIdTaken': { de: 'Es gibt schon einen Dienst mit der Kennung {id}.', en: 'A service with the id {id} already exists.' },
  'error.invalidImage': { de: 'Ungültiger Image-Name: {image}', en: 'Invalid image name: {image}' },
  'error.serviceConnectFailed': { de: 'Verbindung zum Server fehlgeschlagen: {error}', en: 'Could not connect to the server: {error}' },
  'error.serviceNotManaged': { de: 'Nur von CoCoon verwaltete Dienste lassen sich starten und stoppen.', en: 'Only services managed by CoCoon can be started and stopped.' },
  'error.serviceNoNetwork': { de: 'Die Sandbox hat kein Netzwerk („Kein Netzwerk“) und kann keine Dienste nutzen.', en: 'The sandbox has no network ("No network") and cannot use services.' },
  'error.serviceProvisionFailed': { de: 'Datenbank für die Sandbox in {service} konnte nicht angelegt werden: {error}', en: 'Could not create the sandbox database in {service}: {error}' },
  'error.serviceNotAttached': { de: '{service} ist dieser Sandbox nicht zugeordnet.', en: '{service} is not attached to this sandbox.' },
  'error.serviceUnavailable': { de: '{service} ist nicht erreichbar: {error}', en: '{service} is not reachable: {error}' },
  'error.serviceNotReady': { de: 'Dienst ist nicht rechtzeitig bereit geworden: {error}', en: 'Service did not become ready in time: {error}' },
  'error.repoPathTaken': { de: 'Im Arbeitsordner gibt es schon „{path}“ – bitte einen anderen Ordner wählen.', en: '“{path}” already exists in the workspace – please choose another folder.' },
  'error.repoCloneFailed': { de: 'Repository {url} konnte nicht geklont werden: {error}', en: 'Could not clone repository {url}: {error}' },
  'error.repoNotFound': { de: 'Kein Repository im Ordner „{path}“. Vorhanden: {repos}', en: 'No repository in folder “{path}”. Available: {repos}' },
  'error.repoRequired': { de: 'Diese Sandbox hat mehrere Repositories – bitte eines angeben ({repos}).', en: 'This sandbox has several repositories – please specify one ({repos}).' },
  'error.repoRootRemove': { de: 'Das Repository im Arbeitsordner selbst lässt sich nicht entfernen.', en: 'The repository in the workspace folder itself cannot be removed.' },
  'error.sandboxNotRunning': { de: 'Sandbox {name} läuft nicht (Status: {status})', en: 'Sandbox {name} is not running (status: {status})' },
  'error.sandboxLimit': { de: 'Maximale Anzahl Sandboxes erreicht ({max})', en: 'Maximum number of sandboxes reached ({max})' },
  'error.repoNeedsNetwork': {
    de: 'Zum Klonen eines Repositories braucht die Sandbox Internetzugang (nicht „Kein Internet“).',
    en: 'Cloning a repository requires internet access (not "No internet").',
  },
  'error.skillInvalid': { de: 'Ungültiger Skill „{skill}“ – erwartet wird ein GitHub-Eintrag wie owner/repo oder owner/repo/pfad@ref.', en: 'Invalid skill "{skill}" – expected a GitHub reference like owner/repo or owner/repo/path@ref.' },
  'error.skillNeedsNetwork': { de: 'Zum Installieren von Skills braucht die Sandbox Internetzugang (nicht „Kein Internet“).', en: 'Installing skills requires internet access (not "No internet").' },
  'error.skillInstallFailed': { de: 'Skill {skill} konnte nicht installiert werden: {error}', en: 'Could not install skill {skill}: {error}' },
  'error.sandboxNameTaken': { de: 'Es gibt schon eine Sandbox namens „{name}“', en: 'A sandbox named "{name}" already exists' },
  'error.sandboxCreateFailed': { de: 'Sandbox konnte nicht erstellt werden: {error}', en: 'Could not create the sandbox: {error}' },
  'error.sandboxNoContainer': { de: 'Sandbox {name} hat keinen Container', en: 'Sandbox {name} has no container' },
  'error.creationInterrupted': { de: 'Erstellung wurde unterbrochen', en: 'Creation was interrupted' },
  'error.dirNotFound': { de: 'Ordner {path} nicht gefunden', en: 'Folder {path} not found' },
  'error.fileNotFound': { de: 'Datei {path} nicht gefunden', en: 'File {path} not found' },
  'error.cannotDeleteDir': { de: 'Dieser Ordner kann nicht gelöscht werden', en: 'This folder cannot be deleted' },
  'error.nothingToCommit': { de: 'Keine Änderungen zum Committen', en: 'No changes to commit' },
  'error.noRemote': {
    de: 'Diese Sandbox hat kein Repository (kein „origin“) – Push nicht möglich',
    en: 'This sandbox has no repository ("origin") – cannot push',
  },
  'error.pushNeedsToken': {
    de: 'Für den Push zu GitHub wird ein GitHub-Token benötigt (Einstellungen → Zugangsdaten)',
    en: 'Pushing to GitHub requires a GitHub token (Settings → Credentials)',
  },
  'error.prGithubOnly': { de: 'Pull Requests werden nur für GitHub-Repositories unterstützt', en: 'Pull requests are only supported for GitHub repositories' },
  'error.prNeedsToken': {
    de: 'Für Pull Requests wird ein GitHub-Token benötigt (Einstellungen → Zugangsdaten)',
    en: 'Pull requests require a GitHub token (Settings → Credentials)',
  },
  'error.issuesNeedToken': {
    de: 'Für private Repositories wird ein GitHub-Token benötigt (Einstellungen → Zugangsdaten)',
    en: 'Private repositories require a GitHub token (Settings → Credentials)',
  },
  'error.github': { de: 'GitHub: {message}', en: 'GitHub: {message}' },

  // setup checklist
  'setup.docker': { de: 'Sandbox-Technik ({name}) ist bereit', en: 'Sandbox backend ({name}) is ready' },
  'setup.image': { de: 'Sandbox-Umgebung und Agent-Werkzeuge sind bereit', en: 'Sandbox environment and agent tools are ready' },
  'setup.toolboxMissing': { de: 'Agent-Werkzeuge (z. B. Claude Code, Codex, OpenCode, Pi) sind noch nicht installiert', en: 'Agent tools (e.g. Claude Code, Codex, OpenCode, Pi) are not installed yet' },
  'setup.imageBuilding': { de: 'Wird gerade gebaut …', en: 'Building …' },
  'setup.proxy': { de: 'Netzwerk-Schutz (Egress-Proxy) läuft', en: 'Network protection (egress proxy) is running' },
  'setup.credentials': { de: 'Zugangsdaten für einen KI-Agenten hinterlegt', en: 'Credentials for an AI agent are set up' },
  'setup.credentialsHint': {
    de: 'z. B. Anthropic API-Key für Claude Code oder ein eigener API-Anbieter',
    en: 'e.g. an Anthropic API key for Claude Code or a custom API provider',
  },
  'setup.sandbox': { de: 'Erste Sandbox erstellt', en: 'First sandbox created' },
  'setup.agent': { de: 'Ersten Agenten gestartet', en: 'First agent started' },

  // activity log
  'activity.agentStarted': { de: 'Agent {kind} ({id}) gestartet', en: 'Agent {kind} ({id}) started' },
  'activity.agentWorking': { de: 'Agent {kind} ({id}) arbeitet', en: 'Agent {kind} ({id}) is working' },
  'activity.agentBlocked': { de: 'Agent {kind} ({id}) wartet auf deine Entscheidung', en: 'Agent {kind} ({id}) is waiting for your decision' },
  'activity.agentDone': { de: 'Agent {kind} ({id}) ist fertig', en: 'Agent {kind} ({id}) is done' },
  'activity.agentExited': { de: 'Agent {kind} ({id}) wurde beendet', en: 'Agent {kind} ({id}) exited' },
  'activity.agentExitedCode': { de: 'Agent {kind} ({id}) wurde beendet (Exit-Code {code})', en: 'Agent {kind} ({id}) exited (exit code {code})' },
  'activity.sandboxCreating': { de: 'Sandbox „{name}“ wird erstellt', en: 'Creating sandbox "{name}"' },
  'activity.sandboxRunning': { de: 'Sandbox „{name}“ läuft', en: 'Sandbox "{name}" is running' },
  'activity.sandboxStopped': { de: 'Sandbox „{name}“ wurde gestoppt', en: 'Sandbox "{name}" was stopped' },
  'activity.sandboxError': { de: 'Sandbox „{name}“ hat einen Fehler: {error}', en: 'Sandbox "{name}" failed: {error}' },
  'activity.sandboxMissing': { de: 'Sandbox „{name}“ ist verschwunden (Container fehlt)', en: 'Sandbox "{name}" disappeared (container missing)' },
  'activity.sandboxDeleted': { de: 'Sandbox {id} gelöscht', en: 'Sandbox {id} deleted' },
  'activity.imageBuilt': { de: '„{kind}“ erfolgreich gebaut bzw. installiert', en: '"{kind}" built / installed successfully' },
  'activity.imageFailed': { de: 'Image „{kind}“ konnte nicht gebaut werden: {error}', en: 'Image "{kind}" could not be built: {error}' },
  'activity.imageAutoBuild': {
    de: 'Sandbox-Image fehlt – wird jetzt automatisch gebaut (dauert einige Minuten)',
    en: 'Sandbox image missing – building it now (takes a few minutes)',
  },
  'activity.toolboxAutoInstall': {
    de: 'Agent-Werkzeuge (Claude Code, Codex, OpenCode, Pi) werden jetzt installiert (dauert einige Minuten)',
    en: 'Installing the agent tools (Claude Code, Codex, OpenCode, Pi) now (takes a few minutes)',
  },
  'activity.toolboxRuntimeInstall': {
    de: 'Die Agent-Werkzeuge werden neu installiert, jetzt mit eigenem Node.js (das schlanke Sandbox-Image enthält keins mehr)',
    en: 'Reinstalling the agent tools, now with their own Node.js (the slim sandbox image no longer contains it)',
  },
  'activity.updatesAvailable': {
    de: 'Updates verfügbar ({items}) – siehe Einstellungen → Updates',
    en: 'Updates available ({items}) – see Settings → Updates',
  },
  'activity.cocoonUpdated': { de: 'CoCoon wurde auf {version} ({commit}) aktualisiert', en: 'CoCoon was updated to {version} ({commit})' },
  'activity.cocoonUpdateFailed': { de: 'CoCoon-Update fehlgeschlagen: {error}', en: 'CoCoon update failed: {error}' },
  'activity.portsFailed': { de: 'Port-Gateway konnte nicht gestartet werden: {error}', en: 'The port gateway could not be started: {error}' },
  'activity.portOpened': { de: 'Port {port} von „{sandbox}“ als Vorschau geöffnet', en: 'Port {port} of "{sandbox}" opened as a preview' },
  'activity.portShared': { de: 'Port {port} von „{sandbox}“ im Netzwerk freigegeben', en: 'Port {port} of "{sandbox}" shared on the network' },
  'activity.portClosed': { de: 'Port {port} von „{sandbox}“ geschlossen', en: 'Port {port} of "{sandbox}" closed' },
  'activity.restarting': { de: 'CoCoon startet neu', en: 'CoCoon is restarting' },
  'activity.proxyFailed': { de: 'Egress-Proxy konnte nicht gestartet werden: {error}', en: 'Egress proxy could not be started: {error}' },
  'activity.secretSaved': { de: 'Zugangsdaten „{name}“ gespeichert', en: 'Credential "{name}" saved' },
  'activity.secretDeleted': { de: 'Zugangsdaten „{name}“ gelöscht', en: 'Credential "{name}" deleted' },
  'activity.envChanged': { de: 'Umgebungsvariablen ({level} „{label}“) geändert: {count}', en: 'Environment variables ({level} "{label}") changed: {count}' },
  'activity.envFileFailed': { de: 'Die .env-Datei in „{sandbox}“ konnte nicht geschrieben werden: {error}', en: 'The .env file in "{sandbox}" could not be written: {error}' },
  'error.envReserved': { de: '„{name}“ wird von CoCoon selbst gesetzt und lässt sich nicht überschreiben.', en: '"{name}" is set by CoCoon itself and cannot be overridden.' },
  'error.envFilePath': {
    de: 'Ungültiger Pfad „{path}“ für die .env-Datei: erlaubt sind relative Pfade aus Buchstaben, Ziffern, „.“, „_“ und „-“ (ohne „..“ und „.git“).',
    en: 'Invalid .env file path "{path}": only relative paths of letters, digits, ".", "_" and "-" are allowed (no ".." or ".git").',
  },
  'error.envProxyHost': { de: '„{host}“ ist kein gültiger Hostname für den Credential-Proxy (z. B. api.stripe.com).', en: '"{host}" is not a valid host name for the credential proxy (e.g. api.stripe.com).' },
  'error.envProxyName': {
    de: 'Variablen für den Credential-Proxy brauchen einen Namen aus Großbuchstaben, Ziffern und „_“ (z. B. STRIPE_API_KEY): {name}',
    en: 'Variables for the credential proxy need a name of capital letters, digits and "_" (e.g. STRIPE_API_KEY): {name}',
  },
  'error.envNoValue': { de: 'Für „{name}“ fehlt der Wert.', en: 'The value of "{name}" is missing.' },
  'error.envValueUnreadable': { de: 'Der Wert von „{name}“ lässt sich nicht entschlüsseln (Schlüsseldatei env.key fehlt oder wurde ersetzt) – bitte neu setzen.', en: 'The value of "{name}" cannot be decrypted (key file env.key is missing or was replaced) – please set it again.' },
  'env.skippedProxy': {
    de: 'Nicht eingefügt: Der Credential-Proxy ist für diese Sandbox nicht verfügbar (Netzwerk „kein Netz“ oder Schutz für API-Keys aus) – der Wert würde sonst im Klartext in die Sandbox gelangen.',
    en: 'Not injected: the credential proxy is not available for this sandbox (network "none" or API key protection off) – the value would otherwise reach the sandbox in plain text.',
  },
  'env.fileTracked': { de: '{path} ist im Repository versioniert – CoCoon schreibt dort nichts hinein, damit keine Secrets in Diffs landen.', en: '{path} is tracked in the repository – CoCoon does not write to it so that no secrets end up in diffs.' },
  'env.fileForeign': { de: '{path} existiert und stammt nicht von CoCoon – sie wird nicht überschrieben.', en: '{path} exists and was not created by CoCoon – it is not overwritten.' },
  'env.fileNoGit': { de: 'Der Ordner ist kein git-Repository – ohne git-Ausschluss wird keine .env-Datei geschrieben.', en: 'The folder is not a git repository – no .env file is written without a git exclude.' },
  'activity.tokenCreated': { de: 'API-Token „{name}“ erstellt', en: 'API token "{name}" created' },

  // provider test
  'provider.ok': { de: 'Verbindung erfolgreich', en: 'Connection successful' },
  'provider.okModels': { de: 'Verbindung erfolgreich – {count} Modelle gefunden', en: 'Connection successful – {count} models found' },
  'provider.authFailed': {
    de: 'Anmeldung abgelehnt (HTTP {status}) – bitte den API-Key prüfen',
    en: 'Authentication rejected (HTTP {status}) – please check the API key',
  },
  'provider.httpError': { de: 'Der Server antwortet mit HTTP {status}: {message}', en: 'The server responded with HTTP {status}: {message}' },
  'provider.unreachable': { de: 'Nicht erreichbar: {error}', en: 'Not reachable: {error}' },
  'provider.missingKey': { de: 'Kein API-Key hinterlegt ({secret})', en: 'No API key stored ({secret})' },

  // tasks & workspaces
  'error.taskRunning': { de: 'Die Aufgabe „{title}“ läuft bereits', en: 'Task "{title}" is already running' },
  'error.taskNotInReview': { de: 'Die Aufgabe „{title}“ wartet gerade nicht auf ein Review', en: 'Task "{title}" is not waiting for a review' },
  'error.taskDependencies': { de: 'Die Aufgabe wartet noch auf: {titles}', en: 'The task is still waiting for: {titles}' },
  'error.taskUseStart': { de: 'Zum Starten bitte „Starten“ verwenden', en: 'Use "Start" to run a task' },
  'error.unknownWorkflow': { de: 'Unbekannter Ablauf „{id}“', en: 'Unknown workflow "{id}"' },
  'error.unknownDependency': { de: 'Abhängigkeit {id} gehört nicht zu diesem Workspace', en: 'Dependency {id} does not belong to this workspace' },
  'note.preparingSandbox': { de: 'Sandbox wird vorbereitet …', en: 'Preparing sandbox …' },
  'note.startingStage': { de: 'Starte „{stage}“ …', en: 'Starting "{stage}" …' },
  'note.interrupted': { de: 'Start wurde durch einen Neustart des Servers unterbrochen', en: 'Start was interrupted by a server restart' },
  'note.exitCode': { de: 'Der Agent wurde mit Exit-Code {code} beendet', en: 'The agent exited with code {code}' },
  'note.agentGone': { de: 'Der Agent wurde beendet, bevor er fertig war', en: 'The agent ended before it finished' },
  'note.published': { de: 'Übernommen: Branch „{branch}“ hochgeladen ({repos}), Sandbox entfernt', en: 'Accepted: pushed branch "{branch}" ({repos}), sandbox removed' },
  'note.publishedNothing': { de: 'Übernommen: keine Änderungen, Sandbox entfernt', en: 'Accepted: no changes, sandbox removed' },
  'note.reviewing': { de: 'Code-Review läuft ({step}/{total}) …', en: 'Code review running ({step}/{total}) …' },
  'note.reviewChanges': { de: 'Code-Review: Änderungen nötig – {summary}', en: 'Code review: changes requested – {summary}' },
  'note.reviewNoResult': { de: 'Der Review-Agent hat kein Ergebnis hinterlassen. „Freigeben“ startet das Review erneut.', en: 'The review agent left no result. "Approve" runs the review again.' },
  'note.reviewNoToken': { de: 'Der Review-Agent soll selbst hochladen, aber es ist kein GitHub-Token hinterlegt (Einstellungen → Zugangsdaten → GITHUB_TOKEN).', en: 'The review agent is supposed to push, but no GitHub token is stored (Settings → Credentials → GITHUB_TOKEN).' },
  'note.reviewNoSandbox': { de: 'Für das Code-Review fehlt die Sandbox der Aufgabe.', en: 'The task has no sandbox for the code review.' },
  'note.reviewPublishFailed': { de: 'Review bestanden, aber Hochladen/Pull Request fehlgeschlagen: {error}', en: 'Review passed, but pushing / the pull request failed: {error}' },
  'note.prOpened': { de: 'Review bestanden: Branch „{branch}“ hochgeladen, Pull Request: {urls}', en: 'Review passed: pushed branch "{branch}", pull request: {urls}' },
  'note.prOpenedRemoved': { de: 'Review bestanden: Branch „{branch}“ hochgeladen, Pull Request: {urls} – Sandbox entfernt', en: 'Review passed: pushed branch "{branch}", pull request: {urls} – sandbox removed' },
  'note.reviewPushed': { de: 'Review bestanden: Branch „{branch}“ hochgeladen ({repos})', en: 'Review passed: pushed branch "{branch}" ({repos})' },
  'note.reviewApprovedNothing': { de: 'Review bestanden – keine Änderungen zum Hochladen', en: 'Review passed – no changes to push' },
  'note.scheduledOk': { de: 'Geplanter Lauf: alles in Ordnung – {summary}', en: 'Scheduled run: all good – {summary}' },
  'note.scheduledActionNeeded': { de: 'Geplanter Lauf: bitte ansehen – {summary}', en: 'Scheduled run: needs your attention – {summary}' },
  'note.scheduledNoReport': {
    de: 'Geplanter Lauf: Der Agent hat keinen Bericht hinterlassen – sieh dir seine Ausgabe an.',
    en: 'Scheduled run: the agent left no report – have a look at its output.',
  },
  'schedule.previousOpen': { de: 'Der vorherige Lauf {handle} ist noch nicht abgeschlossen', en: 'The previous run {handle} is not finished yet' },
  'error.invalidCron': { de: 'Ungültiger Zeitplan „{cron}“: {error}', en: 'Invalid schedule "{cron}": {error}' },
  'error.invalidTimezone': { de: 'Unbekannte Zeitzone „{timezone}“ (z. B. Europe/Berlin)', en: 'Unknown time zone "{timezone}" (e.g. Europe/Berlin)' },
  'activity.scheduleCreated': { de: 'Geplanter Agent „{name}“ angelegt', en: 'Scheduled agent "{name}" created' },
  'activity.scheduleStarted': { de: 'Geplanter Agent „{name}“ gestartet: {handle}', en: 'Scheduled agent "{name}" started: {handle}' },
  'activity.scheduleSkipped': { de: 'Geplanter Agent „{name}“ übersprungen: {reason}', en: 'Scheduled agent "{name}" skipped: {reason}' },
  'activity.scheduleFailed': { de: 'Geplanter Agent „{name}“ konnte nicht starten: {error}', en: 'Scheduled agent "{name}" could not start: {error}' },
  'note.failed': { de: 'Start fehlgeschlagen: {error}', en: 'Start failed: {error}' },
  'activity.taskCreated': { de: 'Aufgabe „{title}“ erstellt', en: 'Task "{title}" created' },
  'activity.taskRunning': { de: 'Aufgabe „{title}“ läuft', en: 'Task "{title}" is running' },
  'activity.taskReview': { de: 'Aufgabe „{title}“ ist bereit zum Review', en: 'Task "{title}" is ready for review' },
  'activity.taskDone': { de: 'Aufgabe „{title}“ erledigt', en: 'Task "{title}" done' },
  'activity.taskFailed': { de: 'Aufgabe „{title}“ fehlgeschlagen: {note}', en: 'Task "{title}" failed: {note}' },
  'activity.workspaceCreated': { de: 'Workspace „{name}“ erstellt', en: 'Workspace "{name}" created' },

  // notifications (webhook)
  'notify.agentBlocked': { de: '⏳ Agent {kind} in „{sandbox}“ wartet auf deine Entscheidung', en: '⏳ Agent {kind} in "{sandbox}" is waiting for your decision' },
  'notify.taskReview': { de: '👀 Aufgabe „{title}“ ist bereit zum Review', en: '👀 Task "{title}" is ready for review' },
  'notify.taskFailed': { de: '❌ Aufgabe „{title}“ ist fehlgeschlagen: {note}', en: '❌ Task "{title}" failed: {note}' },
  'notify.scheduledReview': { de: '🔔 Geplanter Lauf „{title}“ braucht dich: {summary}', en: '🔔 Scheduled run "{title}" needs you: {summary}' },
  'notify.taskDone': { de: '✅ Aufgabe „{title}“ ist erledigt', en: '✅ Task "{title}" is done' },
  'notify.test': { de: '🐛 Testnachricht von CoCoon – Benachrichtigungen funktionieren.', en: '🐛 Test message from CoCoon – notifications work.' },
  'notify.noWebhook': { de: 'Keine Webhook-URL eingetragen', en: 'No webhook URL configured' },
  'notify.sent': { de: 'Nachricht gesendet', en: 'Message sent' },
  'notify.httpError': { de: 'Der Webhook antwortet mit HTTP {status}', en: 'The webhook responded with HTTP {status}' },

  // console
  'console.running': { de: 'CoCoon läuft', en: 'CoCoon is running' },
  'console.login': { de: 'Anmelden', en: 'Log in' },
  'console.tokenFile': { de: 'Token liegt auch in {file}', en: 'The token is also stored in {file}' },
  'console.envToken': { de: 'Anmelden mit dem Token aus COCOON_TOKEN.', en: 'Log in with the token from COCOON_TOKEN.' },
  'console.dockerDown': { de: 'Docker ist nicht erreichbar ({error}). Läuft Docker?', en: 'Docker is not reachable ({error}). Is Docker running?' },
  'console.driverDown': {
    de: 'Keine Sandbox-Technik verfügbar. Installiere Docker, Podman oder (Linux) bubblewrap, oder setze COCOON_DRIVER.\n{error}',
    en: 'No sandbox backend available. Install Docker, Podman or (Linux) bubblewrap, or set COCOON_DRIVER.\n{error}',
  },
  'console.driver': { de: 'Sandbox-Technik', en: 'Sandbox backend' },
} satisfies Record<string, Record<Language, string>>;

export type MessageKey = keyof typeof messages;

const storage = new AsyncLocalStorage<Language>();
let fallbackLanguage: () => Language = () => 'en';

/** Language used when no request context is active (configured in settings.general.language). */
export function setFallbackLanguage(fn: () => Language): void {
  fallbackLanguage = fn;
}

export const currentLanguage = (): Language => storage.getStore() ?? fallbackLanguage();

export const withLanguage = <T>(lang: Language, fn: () => T): T => storage.run(lang, fn);

export function t(key: MessageKey, params: Params = {}, lang: Language = currentLanguage()): string {
  return messages[key][lang].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(messages, key);
}

/** Explicit choice (header / query) wins, then Accept-Language, then the server default. */
export function resolveLanguage(explicit?: string, acceptLanguage?: string): Language {
  const pick = (value?: string) => (value?.toLowerCase().startsWith('de') ? 'de' : value?.toLowerCase().startsWith('en') ? 'en' : undefined);
  return pick(explicit) ?? pick(acceptLanguage?.split(',')[0]) ?? fallbackLanguage();
}
