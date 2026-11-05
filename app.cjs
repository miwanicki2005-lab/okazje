// Plik startowy dla hostingów z Phusion Passenger (DirectAdmin/cPanel "Setup Node.js App"),
// które ładują aplikację przez require() i nie obsługują bezpośrednio modułów ES.
import('./server.js').catch((e) => {
  console.error(e);
  process.exit(1);
});
