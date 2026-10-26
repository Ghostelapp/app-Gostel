# Prototyp integracji Signal — tylko testy lokalne

**Decyzja 24.09.2026: wykluczony z produktu zamkniętego.** Zachowany jako historyczne narzędzie oceny. Domyślny zestaw testów nie uruchamia tego pakietu; wymaga `GHOSTEL_TEST_AGPL_PROTOTYPE=1`. Kierunek wdrożenia opisuje [moduł MLS](../../crypto/ghostel-mls/README.md).

Używa rzeczywistego `@signalapp/libsignal-client` **0.103.0**, przypiętego wraz z integrity w package-lock. Nie implementuje własnego algorytmu ani ratchet. W teście działa podpisany pakiet prekeys z kluczem KEM, szyfrowanie i odszyfrowanie po obu stronach, odrzucanie replay, naruszenia integralności, niepoprawnego podpisu i niezweryfikowanej tożsamości; działa odbiór poza kolejnością.

Uruchomienie z katalogu repozytorium (zweryfikowano Node 24.21.0/macOS):

```sh
npm ci --ignore-scripts --prefix tools/signal-prototype
npm test --prefix tools/signal-prototype
```

Wykorzystano dostarczoną natywną bibliotekę dla tej platformy, bez uruchamiania skryptów instalacyjnych. Inne platformy wymagają weryfikacji dostępności artefaktów lub kontrolowanego builda.

**To nie jest integracja produkcyjna.** Magazyn testowy trzyma jawne dane w pamięci; nie ma transakcji trwałego stanu, kontroli współbieżności, odporności na rollback ani systemowego magazynu kluczy. `verifyPeer` symuluje wcześniej przeprowadzoną niezależną weryfikację, nie udaje sieciowego onboardingu. Usuwanie prekeys jest testową strategią one-time; produkcja musi rozróżniać klucze one-time i last-resort zgodnie z biblioteką. Testy nie są formalnym dowodem FS/PCS ani zewnętrznym audytem.

Nie importować tego modułu do Expo ani backendu. Serwer Ghostel nie ma otrzymywać prywatnych kluczy. Node binding jest natywnym dodatkiem Node, nie przenośną biblioteką dla przeglądarki/React Native. Dla Androida potrzebny jest adapter do Java/JNI, dla iOS Swift, dla desktopa wydzielony proces z kontrolowanym IPC i magazynem OS. Rozwiązanie web wymaga osobnej decyzji z uwzględnieniem dostarczania kodu przez serwer.

Repozytorium libsignal deklaruje brak wsparcia zastosowań poza Signal i możliwość zmian API. Pakiet ma licencję AGPL-3.0-only — przed dystrybucją integracji trzeba ustalić zgodny model dystrybucji Ghostel; ten prototyp nie rozstrzyga obowiązków prawnych.

Źródła: [libsignal README](https://github.com/signalapp/libsignal/blob/main/README.md), [licencja libsignal](https://github.com/signalapp/libsignal/blob/main/LICENSE), [Signal Double Ratchet](https://signal.org/docs/specifications/doubleratchet/). Dla grup kandydatem do osobnej oceny jest [OpenMLS](https://github.com/openmls/openmls); nie wdrożono go w tym prototypie.

Następne kroki integracji: trwały transakcyjny store sesji po stronie klienta, per-device API prekeys z atomowym pobieraniem one-time keys, niezależnie uwierzytelniony katalog urządzeń, natywne adaptery, kodowanie zaszyfrowanych zdarzeń aplikacji, migracja archiwum i ochrona przed downgrade. Następnie testy interoperacyjności Android/iOS/desktop oraz niezależny audyt integracji i protokołu grupowego.
