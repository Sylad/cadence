// Les tests de cadence vérifient eux-mêmes les refus sous CADENCE_ORCHESTRATED (deliver, raf done, orchestrate) :
// lancés depuis une session de vague, ils ne doivent pas hériter de la variable de cette session.
delete process.env.CADENCE_ORCHESTRATED;
