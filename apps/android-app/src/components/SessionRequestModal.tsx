import React from 'react';
import { Modal, Text, View } from 'react-native';
import { rc, shortFingerprint, type Peer } from '../native/rc';
import { colors } from '../theme';
import { Button, styles } from './ui';

/** In-app consent for every session. Android then shows its own screen-capture dialog. */
export function SessionRequestModal({ peer }: { peer?: Peer }) {
  return (
    <Modal visible={!!peer} transparent animationType="fade" onRequestClose={() => rc.respondSession(false)}>
      <View style={{ flex: 1, backgroundColor: '#000000b3', justifyContent: 'flex-end' }}>
        <View
          style={{
            backgroundColor: colors.panel,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            borderColor: colors.line,
            borderWidth: 1,
            padding: 24,
            paddingBottom: 36,
          }}
        >
          <Text style={[styles.h1, { fontSize: 20 }]}>Pedido de controle remoto</Text>
          {peer && (
            <>
              <Text style={[styles.body, { marginTop: 10 }]}>
                <Text style={{ color: colors.fg, fontWeight: '700' }}>{peer.name}</Text> quer ver a tela e controlar este aparelho
                (toques, digitação e navegação).
              </Text>
              <Text style={[styles.body, { fontFamily: 'monospace', fontSize: 12, marginTop: 6 }]}>
                {shortFingerprint(peer.fingerprint)}
              </Text>
            </>
          )}
          <Text style={[styles.body, { marginTop: 12, fontSize: 13 }]}>
            Enquanto a sessão durar, haverá uma notificação fixa e um aviso vermelho na tela. Você pode encerrar a qualquer momento.
          </Text>
          <Button label="Aceitar" onPress={() => rc.respondSession(true)} style={{ marginTop: 20 }} />
          <Button label="Recusar" variant="secondary" onPress={() => rc.respondSession(false)} style={{ marginTop: 8 }} />
        </View>
      </View>
    </Modal>
  );
}
