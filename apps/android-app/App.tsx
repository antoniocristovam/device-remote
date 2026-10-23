import React, { useEffect, useState } from 'react';
import { PermissionsAndroid, Platform, Pressable, StatusBar, Text, ToastAndroid, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { onRcEvent, useRcState } from './src/native/rc';
import { colors } from './src/theme';
import { HomeScreen } from './src/screens/HomeScreen';
import { PairScreen } from './src/screens/PairScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SessionRequestModal } from './src/components/SessionRequestModal';
import { ChatScreen } from './src/screens/ChatScreen';
import { useChat } from './src/native/useChat';

type Tab = 'home' | 'chat' | 'history' | 'settings';
const TABS: { key: Tab; label: string }[] = [
  { key: 'home', label: 'Início' },
  { key: 'chat', label: 'Chat' },
  { key: 'history', label: 'Histórico' },
  { key: 'settings', label: 'Ajustes' },
];

export default function App() {
  const state = useRcState();
  const [tab, setTab] = useState<Tab>('home');
  const [pairing, setPairing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const session = state?.session;
  const sessionPeer = session && session.phase !== 'idle' && session.phase !== 'request' ? session.peer : undefined;
  const chatPeer = sessionPeer ?? state?.peers[0];
  const chat = useChat(chatPeer?.fingerprint, tab === 'chat' && !pairing);

  useEffect(() => {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }
    const t = setInterval(() => setNow(Date.now()), 1000);
    const off = onRcEvent((e) => {
      if (e.type === 'sessionEnded') ToastAndroid.show(`Sessão com ${e.payload.peerName} encerrada`, ToastAndroid.SHORT);
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'bottom']}>
        {!state ? null : pairing ? (
          <PairScreen signalingUrl={state.settings.signalingUrl} onDone={() => setPairing(false)} />
        ) : (
          <>
            <View style={{ flex: 1 }}>
              {tab === 'home' && <HomeScreen state={state} now={now} onPair={() => setPairing(true)} />}
              {tab === 'chat' && (
                <ChatScreen peerName={chatPeer?.name} live={session?.phase === 'live'} entries={chat.entries} transfers={chat.transfers} />
              )}
              {tab === 'history' && <HistoryScreen />}
              {tab === 'settings' && <SettingsScreen state={state} />}
            </View>
            <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.panel }}>
              {TABS.map((t) => (
                <Pressable key={t.key} onPress={() => setTab(t.key)} style={{ flex: 1, paddingVertical: 14, alignItems: 'center' }}>
                  <Text style={{ color: tab === t.key ? colors.fg : colors.dim, fontWeight: tab === t.key ? '700' : '500' }}>
                    {t.label}
                    {t.key === 'chat' && chat.unread > 0 ? ` (${Math.min(chat.unread, 9)})` : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
        <SessionRequestModal peer={state?.session.phase === 'request' ? state.session.peer : undefined} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
