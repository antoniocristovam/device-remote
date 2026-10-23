import React, { useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, Text, TextInput, View } from 'react-native';
import { rc, type ChatEntry, type Transfer } from '../native/rc';
import { colors, radius } from '../theme';
import { styles } from '../components/ui';

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const time = (ts: number) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

type Row = { type: 'entry'; e: ChatEntry } | { type: 'transfer'; t: Transfer };

function Bubble({ e }: { e: Extract<ChatEntry, { kind: 'msg' }> }) {
  const mine = e.from === 'me';
  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <View
        style={{
          maxWidth: '85%',
          backgroundColor: mine ? colors.accent : colors.elevated,
          borderRadius: 18,
          borderBottomRightRadius: mine ? 6 : 18,
          borderBottomLeftRadius: mine ? 18 : 6,
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
      >
        <Text selectable style={{ color: colors.fg, fontSize: 15 }}>
          {e.text}
        </Text>
      </View>
      <Text style={{ color: colors.dim, fontSize: 11, marginTop: 2, marginHorizontal: 4 }}>
        {time(e.ts)}
        {mine ? (e.delivered ? '  ✓✓' : '  ✓') : ''}
      </Text>
    </View>
  );
}

function FileRow({ e }: { e: Extract<ChatEntry, { kind: 'file' }> }) {
  const mine = e.from === 'me';
  const canOpen = e.ok && !!e.uri;
  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <Pressable
        disabled={!canOpen}
        onPress={() => e.uri && rc.openFile(e.uri)}
        style={{
          width: '85%',
          borderWidth: 1,
          borderColor: e.ok ? colors.line : '#7f1d1d',
          backgroundColor: e.ok ? colors.elevated : '#1f0d0d',
          borderRadius: radius.md,
          padding: 12,
        }}
      >
        <Text numberOfLines={1} style={[styles.text, { fontWeight: '600' }]}>
          {mine ? '↑ ' : '↓ '}
          {e.name}
        </Text>
        <Text style={{ color: e.ok ? colors.muted : colors.danger, fontSize: 12, marginTop: 2 }}>
          {formatBytes(e.size)} · {e.ok ? (mine ? 'enviado' : canOpen ? 'recebido · toque para abrir' : 'recebido') : 'falhou'}
        </Text>
      </Pressable>
      <Text style={{ color: colors.dim, fontSize: 11, marginTop: 2, marginHorizontal: 4 }}>{time(e.ts)}</Text>
    </View>
  );
}

function TransferRow({ t }: { t: Transfer }) {
  const pct = t.size ? Math.min(100, (t.bytes / t.size) * 100) : 100;
  const label = { waiting: 'aguardando aceite…', sending: 'enviando', receiving: 'recebendo', verifying: 'verificando…' }[t.state];
  return (
    <View style={{ alignItems: t.from === 'me' ? 'flex-end' : 'flex-start' }}>
      <View style={{ width: '85%', borderWidth: 1, borderColor: colors.accent, backgroundColor: '#17142b', borderRadius: radius.md, padding: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text numberOfLines={1} style={[styles.text, { flex: 1 }]}>
            {t.name}
          </Text>
          {t.state !== 'verifying' && (
            <Pressable onPress={() => rc.cancelTransfer(t.id)} hitSlop={10}>
              <Text style={{ color: colors.muted }}>Cancelar</Text>
            </Pressable>
          )}
        </View>
        <View style={{ height: 4, backgroundColor: colors.line, borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
          <View style={{ height: 4, width: `${pct}%`, backgroundColor: colors.accent }} />
        </View>
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>
          {label} · {formatBytes(t.bytes)} de {formatBytes(t.size)}
        </Text>
      </View>
    </View>
  );
}

export function ChatScreen({
  peerName,
  live,
  entries,
  transfers,
}: {
  peerName?: string;
  live: boolean;
  entries: ChatEntry[];
  transfers: Transfer[];
}) {
  const [draft, setDraft] = useState('');
  const list = useRef<FlatList<Row>>(null);
  const rows: Row[] = [...entries.map((e) => ({ type: 'entry' as const, e })), ...transfers.map((t) => ({ type: 'transfer' as const, t }))];

  const send = async () => {
    if (await rc.sendChat(draft)) setDraft('');
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="height">
      <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.line }}>
        <Text style={styles.h1}>Chat</Text>
        <Text style={[styles.body, { marginTop: 2 }]}>
          {peerName ? (live ? `Conectado a ${peerName}` : `${peerName} · sem sessão ativa`) : 'Nenhuma sessão ativa'}
        </Text>
      </View>
      <FlatList
        ref={list}
        data={rows}
        keyExtractor={(r) => (r.type === 'entry' ? r.e.id : 't' + r.t.id)}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Text style={[styles.body, { textAlign: 'center', marginTop: 40 }]}>
            {live ? 'Envie uma mensagem ou um arquivo para o computador.' : 'O chat fica disponível durante uma sessão.'}
          </Text>
        }
        renderItem={({ item }) =>
          item.type === 'transfer' ? <TransferRow t={item.t} /> : item.e.kind === 'msg' ? <Bubble e={item.e} /> : <FileRow e={item.e} />
        }
      />
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.line }}>
        <Pressable
          accessibilityLabel="Enviar arquivo"
          disabled={!live}
          onPress={rc.pickFiles}
          style={{ width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.elevated, opacity: live ? 1 : 0.4 }}
        >
          <Text style={{ color: colors.fg, fontSize: 20 }}>📎</Text>
        </Pressable>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          editable={live}
          multiline
          placeholder="Mensagem"
          placeholderTextColor={colors.dim}
          style={{
            flex: 1,
            maxHeight: 120,
            minHeight: 44,
            color: colors.fg,
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: 12,
            paddingHorizontal: 12,
            fontSize: 15,
          }}
        />
        <Pressable
          accessibilityLabel="Enviar"
          disabled={!live || !draft.trim()}
          onPress={send}
          style={{
            height: 44,
            paddingHorizontal: 16,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.accent,
            opacity: live && draft.trim() ? 1 : 0.4,
          }}
        >
          <Text style={{ color: colors.fg, fontWeight: '700' }}>Enviar</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
