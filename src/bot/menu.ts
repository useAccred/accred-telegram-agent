import type { TelegramApi } from "./telegram-api";

/**
 * The command menu, registered from code at every start so Telegram's list
 * never drifts from what the bot does. The bot answers in the user's
 * language, so the menu does too for the languages most of its users set.
 */

type Entry = [command: string, description: string];

export const MENU: Record<string, Entry[]> = {
  en: [
    ["status", "Balance, agents, automations, settings"],
    ["agents", "Your trading agents, with buttons"],
    ["alert", "Price and event alerts"],
    ["brief", "Daily brief: hour and sections"],
    ["history", "Credits spent per day"],
    ["export", "Trades or runs as a CSV file"],
    ["model", "Choose the model"],
    ["budget", "Credits per message and per day"],
    ["timezone", "Set your timezone"],
    ["memory", "What I remember about you"],
    ["new", "Start a fresh conversation"],
    ["help", "What I can do"],
  ],
  hi: [
    ["status", "बैलेंस, एजेंट, ऑटोमेशन, सेटिंग"],
    ["agents", "आपके ट्रेडिंग एजेंट, बटन के साथ"],
    ["alert", "कीमत और इवेंट अलर्ट"],
    ["brief", "डेली ब्रीफ: समय और सेक्शन"],
    ["history", "हर दिन खर्च हुए क्रेडिट"],
    ["export", "ट्रेड या रन की CSV फ़ाइल"],
    ["model", "मॉडल चुनें"],
    ["budget", "प्रति संदेश और प्रति दिन क्रेडिट"],
    ["timezone", "अपना टाइमज़ोन सेट करें"],
    ["memory", "मुझे आपके बारे में क्या याद है"],
    ["new", "नई बातचीत शुरू करें"],
    ["help", "मैं क्या कर सकता हूँ"],
  ],
  es: [
    ["status", "Saldo, agentes, automatizaciones, ajustes"],
    ["agents", "Tus agentes de trading, con botones"],
    ["alert", "Alertas de precio y de eventos"],
    ["brief", "Resumen diario: hora y secciones"],
    ["history", "Créditos gastados por día"],
    ["export", "Operaciones o ejecuciones en CSV"],
    ["model", "Elegir el modelo"],
    ["budget", "Créditos por mensaje y por día"],
    ["timezone", "Tu zona horaria"],
    ["memory", "Lo que recuerdo de ti"],
    ["new", "Empezar una conversación nueva"],
    ["help", "Qué puedo hacer"],
  ],
  de: [
    ["status", "Guthaben, Agenten, Automationen, Einstellungen"],
    ["agents", "Deine Trading-Agenten, mit Buttons"],
    ["alert", "Preis- und Ereignis-Alarme"],
    ["brief", "Tagesbriefing: Uhrzeit und Abschnitte"],
    ["history", "Verbrauchte Credits pro Tag"],
    ["export", "Trades oder Läufe als CSV"],
    ["model", "Modell wählen"],
    ["budget", "Credits pro Nachricht und pro Tag"],
    ["timezone", "Deine Zeitzone"],
    ["memory", "Was ich mir über dich merke"],
    ["new", "Neues Gespräch beginnen"],
    ["help", "Was ich kann"],
  ],
  fr: [
    ["status", "Solde, agents, automatisations, réglages"],
    ["agents", "Vos agents de trading, avec boutons"],
    ["alert", "Alertes de prix et d'événements"],
    ["brief", "Brief quotidien : heure et sections"],
    ["history", "Crédits dépensés par jour"],
    ["export", "Trades ou exécutions en CSV"],
    ["model", "Choisir le modèle"],
    ["budget", "Crédits par message et par jour"],
    ["timezone", "Votre fuseau horaire"],
    ["memory", "Ce que je retiens de vous"],
    ["new", "Nouvelle conversation"],
    ["help", "Ce que je sais faire"],
  ],
  ja: [
    ["status", "残高・エージェント・自動化・設定"],
    ["agents", "トレーディングエージェント（ボタン付き）"],
    ["alert", "価格・イベントのアラート"],
    ["brief", "デイリーブリーフ：時刻とセクション"],
    ["history", "1日ごとのクレジット消費"],
    ["export", "取引や実行をCSVで出力"],
    ["model", "モデルを選ぶ"],
    ["budget", "メッセージごと・1日ごとのクレジット"],
    ["timezone", "タイムゾーンを設定"],
    ["memory", "あなたについて覚えていること"],
    ["new", "新しい会話を始める"],
    ["help", "できること"],
  ],
};

export async function registerMenu(api: TelegramApi): Promise<void> {
  for (const [language, entries] of Object.entries(MENU)) {
    const commands = entries.map(([command, description]) => ({ command, description: description.slice(0, 256) }));
    await api.setMyCommands(commands, language === "en" ? undefined : language);
  }
  await api.setMenuButton();
}
