// Supervisor self-test only. This is never a native-acceptance fixture.
process.send?.({
  kind: 'native_accepted', releaseId: 'release-test', bindingId: 'binding-test',
  generation: 0, sessionId: 'session-test', receiptKind: 'harness_queued',
});
setInterval(() => undefined, 1000);
