import React, { useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { rc, shortFingerprint, type RcState } from '../native/rc';
import { colors } from '../theme';
import { Button, Card, Dot, SectionTitle, styles } from '../components/ui';

function elapsed(since: number, now: number) {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function HomeScreen({ state, now, onPair }: { state: RcState; now: number; onPair(): void }) {
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const s = state.session;
  const active = s.phase === 'connecting' || s.phase === 'live' || s.phase === 'reconnecting' ? s : undefined;
  const sigColor = state.signaling === 'online' ? colors.ok : state.signaling === 'connecting' ? colors.warn : colors.dim;

  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
      <Text style={styles.h1}>Remote Controller</Text>
      <Text style={[styles.body, { marginTop: 4 }]}>
        {state.identity.name} · <Text style={{ fontFamily: 'monospace' }}>{shortFingerprint(state.identity.fingerprint)}</Text>
      </Text>

      {active && (
        <Card style={{ marginTop: 20, borderColor: colors.danger, backgroundColor: '#1f0d0d' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Dot color={colors.danger} />
            <Text style={[styles.text, { fontWeight: '700' }]}>
              {active.phase === 'live'
                ? 'Controle remoto ativo'
                : active.phase === 'reconnecting'
                  ? `Reconectando…${active.deadline ? ` ${Math.max(0, Math.ceil((active.deadline - now) / 1000))}s` : ''}`
                  : 'Conectando…'}
            </Text>
            {active.transport === 'usb' && <Text style={[styles.body, { color: colors.ok, fontSize: 12 }]}>via USB</Text>}
            <Text style={[styles.body, { marginLeft: 'auto', fontFamily: 'monospace' }]}>{elapsed(active.startedAt, now)}</Text>
          </View>
          <Text style={[styles.body, { marginTop: 6 }]}>
            {active.phase === 'reconnecting'
              ? `A conexão com ${active.peer.name} caiu. Tentando restabelecer; o indicador continua ativo.`
              : `${active.peer.name} pode ver e controlar este aparelho.`}
            {active.reconnects > 0 ? ` ${active.reconnects} ${active.reconnects === 1 ? 'reconexão' : 'reconexões'} nesta sessão.` : ''}
          </Text>
          <Button label="Encerrar agora" variant="danger" onPress={rc.endSession} style={{ marginTop: 14 }} />
        </Card>
      )}

      <Card style={{ marginTop: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.text, { fontWeight: '600' }]}>Ficar disponível</Text>
            <Text style={[styles.body, { marginTop: 2 }]}>
              Computadores pareados podem pedir conexão. Cada sessão ainda precisa do seu aceite.
            </Text>
          </View>
          <Switch
            value={state.available}
            onValueChange={rc.setAvailable}
            disabled={state.peers.length === 0}
            trackColor={{ true: colors.accent, false: colors.line }}
            thumbColor={colors.fg}
          />
        </View>
        {state.available && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
            <Dot color={sigColor} />
            <Text style={styles.body}>
              Servidor {state.signaling === 'online' ? 'conectado' : state.signaling === 'connecting' ? 'conectando…' : 'offline'}
            </Text>
          </View>
        )}
        {state.available && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <Dot color={state.usb === 'online' ? colors.ok : colors.dim} />
            <Text style={styles.body}>{state.usb === 'online' ? 'Cabo USB conectado (menor atraso)' : 'Cabo USB: não conectado'}</Text>
          </View>
        )}
        {state.available && state.usb !== 'online' && (
          <Text style={[styles.body, { marginTop: 6, fontSize: 12, color: colors.dim }]}>
            Para conectar por cabo, ative a Depuração USB nas Opções do desenvolvedor, ligue o celular ao computador e
            aceite o aviso de depuração.
          </Text>
        )}
      </Card>

      {!state.accessibility && (
        <Card style={{ marginTop: 12, borderColor: '#3f3413' }}>
          <Text style={[styles.text, { fontWeight: '600' }]}>Permitir controle por toque</Text>
          <Text style={[styles.body, { marginTop: 4 }]}>
            Para que o computador possa tocar, digitar e navegar, ative “Remote Controller” em Acessibilidade. Sem isso, o
            computador só consegue ver a tela.
          </Text>
          <Button label="Abrir configurações de acessibilidade" variant="secondary" onPress={rc.openAccessibilitySettings} style={{ marginTop: 12 }} />
        </Card>
      )}

      <SectionTitle>Computadores pareados</SectionTitle>
      {state.peers.length === 0 ? (
        <Card>
          <Text style={styles.body}>Nenhum computador pareado ainda.</Text>
          <Button label="Parear com um computador" onPress={onPair} style={{ marginTop: 12 }} />
        </Card>
      ) : (
        state.peers.map((p) => (
          <Card key={p.fingerprint} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.text, { fontWeight: '600' }]}>{p.name}</Text>
                <Text style={[styles.body, { fontFamily: 'monospace', fontSize: 12 }]}>{shortFingerprint(p.fingerprint)}</Text>
              </View>
              {confirmRemove === p.fingerprint ? (
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Pressable onPress={() => setConfirmRemove(undefined)} style={{ padding: 8 }}>
                    <Text style={styles.body}>Cancelar</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      rc.removePeer(p.fingerprint);
                      setConfirmRemove(undefined);
                    }}
                    style={{ padding: 8 }}
                  >
                    <Text style={{ color: colors.danger, fontWeight: '700' }}>Revogar</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable onPress={() => setConfirmRemove(p.fingerprint)} style={{ padding: 8 }}>
                  <Text style={{ color: colors.danger }}>Revogar acesso</Text>
                </Pressable>
              )}
            </View>
          </Card>
        ))
      )}
      {state.peers.length > 0 && (
        <Button label="Parear outro computador" variant="secondary" onPress={onPair} style={{ marginTop: 8 }} />
      )}

      <Text style={[styles.body, { marginTop: 28, fontSize: 12, color: colors.dim }]}>
        Durante uma sessão, uma notificação fixa e um aviso vermelho na tela ficam visíveis o tempo todo. Revogar um computador
        encerra qualquer sessão dele imediatamente.
      </Text>
    </ScrollView>
  );
}

