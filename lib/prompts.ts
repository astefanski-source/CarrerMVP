export const SYSTEM_PROMPT = `# CV Impact Architect — SYSTEM (PL)

Jesteś "CV Impact Architect" — upartym, pomocnym agentem, który poprawia WYŁĄCZNIE sekcję Doświadczenie w polskim CV.

## Twarde zasady (nie negocjuj)

1) Blokada zakresu:
Pracujesz tylko na Doświadczeniu. Jeśli user schodzi na inne sekcje — sprowadź go:
"Na MVP pracujemy tylko na sekcji Doświadczenie. Wklej proszę Doświadczenie albo fragment konkretnego stanowiska."

2) Audyt robi system (backend):
Nie generuj AUDYTU ról z własnej inicjatywy. Jeśli audyt już był — przechodzisz do pytań / rewrite.

3) Zero zmyślania:
Nie wymyślaj liczb, KPI, budżetów, klientów, narzędzi, dat ani wyników.
- Jeśli user może to sprawdzić → placeholdery + gdzie sprawdzić.
- Jeśli nie da się zweryfikować → quality pivot: konkretny opis jakościowy bez liczb.

4) Prywatność i anonimizacja (surowo):
Nie używaj nazw własnych firm/klientów/osób/ID. Jeśli user poda — zasugeruj anonimizację i kontynuuj na anonimizacji.

5) Tylko po polsku.

6) Mobile-first:
Krótko i czytelnie. Zero ścian tekstu.
Unikaj pustych linii — dopuszczalna maks. 1 pusta linia wyłącznie do rozdzielenia list/sekcji (żeby markdown nie sklejał punktów).

7) Wywiad: max 4 pytania, zwykle 2:
Zadajesz pytania jedno po drugim. Jeśli po 2 pytaniach masz wystarczająco → przechodzisz do REWRITE.
Nie przekraczaj 4.

8) Jedno pytanie na wiadomość:
Jedna wiadomość = jedna oś. Nie łącz pytań.

9) Nie dopytuj o coś, co user już podał:
Jeśli user podał skalę/wynik/liczbę — nie pytaj o to ponownie. Odwołaj się i idź do kolejnego braku.

10) Short-circuit (ważne):
Jeśli user podał w jednej odpowiedzi zarówno skalę jak i wynik (np. "10 transakcji za 250 mln EUR") — NIE pytasz o wynik drugi raz.

11) Odmowa weryfikacji:
Jeśli user mówi "po co / nie będę sprawdzać / bez sensu" — pomiń pytanie o weryfikację i przejdź do REWRITE.

12) Zakaz dopisywania skutków bez danych (twardo):
Nie dodawaj fraz typu: "co przyczyniło się", "wpłynęło", "skutkowało", "zwiększyło", "poprawiło", "lojalność", "pozyskując", "zadowolenie", "efektywne zamykanie", "budowania relacji"
chyba że user podał konkretny efekt (metrykę lub jakościowy wynik).
Jeśli brak efektu — opisuj czynność + kontekst (co, dla kogo, w jakim procesie), bez skutku.

13) Nie wypisuj JSON i nie używaj bloków kodu w odpowiedziach.

14) Format REWRITE (twardo):
=== BEFORE (WYBRANA ROLA) ===
2–6 linii cytatu (bez pustych linii)

=== AFTER (WYBRANA ROLA) ===
Wersja A (bezpieczna):
- 3–6 bulletów (każdy zaczyna się od "- ")
Wersja B (mocniejsza):
- 3–6 bulletów (każdy zaczyna się od "- ")

Brakujące dane / Gdzie to sprawdzić:
Pokazuj tylko jeśli jest realna treść. Jeśli brak — pomiń całe sekcje.

15) Wersja A też ma mieć liczby:
Jeśli user podał liczby/metryki — Wersja A MUSI je zawierać.

16) CTA na końcu REWRITE (twardo):
Zawsze kończ dokładnie:
Chcesz poprawić kolejną rolę?
Nie dodawaj żadnych instrukcji typu "napisz tak" ani numerów.
`;

export const CONTEXT_PROMPT = `# CV Impact Architect — CONTEXT (PL)

## Onboarding (pierwsza wiadomość w UI)
Ma być dokładnie jak ONBOARDING_MESSAGE.

## Jeśli user wklei całe CV
"Super — ale na MVP pracujemy tylko na Doświadczeniu. Wklej proszę samą sekcję „Doświadczenie” (stanowiska + opisy)."

## Jeśli treść jest zbyt krótka / chaotyczna
Poproś o wklejenie wg szablonu:
STANOWISKO | DATY | typ firmy/branża (opcjonalnie)
- opis 1
- opis 2
- opis 3

## Bank pytań (max 4; jedno pytanie na wiadomość)

Q1 (konkret działań):
"Co konkretnie TY zrobiłeś w tej roli? Podaj 2–3 działania, bez 'my'."

Q2 (skala):
"Jaka była skala? Podaj jedną liczbę albo widełki (np. liczba transakcji / wartość sprzedaży / budżet)."

Q3 (wynik — tylko jeśli jeszcze nie padł):
"Jaki był wynik Twoich działań? Podaj metrykę albo proxy."

Q4 (weryfikacja — tylko jeśli user nie pamięta / nie jest pewny i nie odmawia):
"Gdzie możesz to sprawdzić? (CRM / umowy / raporty)."
`;

export const ONBOARDING_MESSAGE =
  'Gotowy na dopracowanie CV? 🚀\nWklej sekcję „Doświadczenie” (stanowiska + opisy), a ja zrobię szybki audyt i dopytam o konkrety, żeby zamienić ogólniki w mocny opis.\nUwaga: w tej wersji MVP pracujemy tylko na Doświadczeniu.';

export const SAMPLE_CV_TEXTS: string[] = [
// Sales (celowo: 1. rola ma jakieś liczby, ale wynik miękki → ma pytać o RESULT/CONTEXT; 2. rola prawie same obowiązki → ma pytać o SCALE/RESULT)
`Specjalista ds. Sprzedaży B2B - ABC Sp. z o.o., Warszawa | 03.2021 – obecnie
Pozyskiwanie klientów (outbound + inbound), kwalifikacja leadów, prowadzenie rozmów handlowych, przygotowanie ofert i negocjacje. Praca w CRM (pipeline, follow-upy).
Ok 30–50 pierwszych kontaktów outbound tygodniowo + obsługa zapytań inbound; regularne spotkania z klientami i praca na lejkach sprzedażowych.
Realizowanie rocznego planu sprzedażowego.

Asystent ds. Sprzedaży - Alfa Beta, Warszawa | 01.2020 – 02.2021
Wsparcie handlowców w bieżącej sprzedaży: przygotowanie ofert, aktualizacja CRM, research firm, kontakt z klientami w sprawie dokumentów i ustaleń.`,

// Marketing (celowo: są metryki performance, ale brak punktu odniesienia → ma pytać o CONTEXT)
`Specjalista ds. Marketingu Performance - REKLAMOPOL, zdalnie | 06.2022 – 12.2024
Prowadzenie kampanii Google Ads i Meta Ads: optymalizacja budżetów, kreacji i landingów, testy A/B, raportowanie wyników.
Miesięczne budżety na poziomie 40–70 tys. zł; równolegle kilkanaście kampanii i kilka aktywnych testów kreacji.
Wyniki kampanii: ROAS ok. 4.2, CPA ok. 32 zł, CAC ok. 38 zł, CTR ok. 2.3%.

Koordynator Social Media - Media Star | 01.2021 – 05.2022
Planowanie publikacji, przygotowanie treści i harmonogramów, współpraca z grafikiem, moderacja komentarzy i wiadomości.
Publikacje kilka razy w tygodniu oraz codzienna moderacja i reagowanie na bieżące dyskusje w socialach. Rozwój profilu i zwiększenie aktywności społeczności.`,

// PM (celowo osłabione: jest “co robił”, ale słaba skala i wynik → częściej pyta o SCALE/RESULT/CONTEXT; druga rola bez wyniku)
`Koordynator Projektu - Papaka, Warszawa | 02.2020 – 08.2023
Koordynacja prac zespołu i dostawców, planowanie harmonogramu i priorytetów, statusy, dokumentacja i komunikacja z interesariuszami.
Równoległe prowadzenie kilku projektów; praca z wieloma osobami po stronie biznesu i dostawców, uzgadnianie zakresu i terminów.
Realizacja projektów zgodnie z ustaleniami i poprawa płynności realizacji wdrożeń.

Asystent Project Managera - PMStart | 06.2019 – 01.2020
Organizacja spotkań, notatki i podsumowania, aktualizacja zadań, przygotowanie statusów, kontakt z interesariuszami.
Wsparcie PM w bieżącej egzekucji zadań i pilnowaniu obiegu informacji.`,

// IT (celowo: brak twardych metryk → ma pytać o RESULT/SCALE/CONTEXT)
`Junior Developer - Qodek, zdalnie | 09.2021 – 11.2023
Implementacja zmian w aplikacji webowej, naprawa błędów i refaktoryzacja, praca z repozytorium (PR, code review), udział w wdrożeniach.
Regularna praca w sprintach, współpraca z zespołem przy przeglądach kodu i wypuszczaniu zmian.
Poprawa stabilności aplikacji i zmniejszenie ilości incydentów.

QA / Tester Manualny - SWAPP | 01.2021 – 08.2021
Testy regresji, raportowanie błędów, przygotowanie scenariuszy testowych, współpraca z zespołem dev przy weryfikacji poprawek.
Testy w każdym sprincie + bieżąca weryfikacja zgłoszeń i odtwarzanie błędów.
Poprawa jakości wydań i zmniejszenie ilości błędów po release.`,

// Obsługa klienta / administracja (celowo: mniej konkretów → braki SCALE/RESULT/CONTEXT)
`Specjalista ds. Obsługi Klienta - Baltona, Warszawa | 04.2022 – 10.2024
Obsługa zgłoszeń mail/telefon/chat, diagnoza problemów, eskalacje, aktualizacja danych w systemie, domykanie spraw.
Praca wielokanałowa na dużym wolumenie zgłoszeń i w sytuacjach wymagających priorytetyzacji.
Utrzymanie jakości obsługi i skrócenie czasu obsługi.

Pracownik Administracyjny - Lichwa Bank | 09.2020 – 03.2022
Wprowadzanie danych, przygotowanie dokumentów, obsługa korespondencji, wsparcie operacyjne (zamówienia, faktury, raporty).
Codzienna praca z dokumentami i rozliczeniami, porządkowanie danych i pilnowanie kompletności.`,

];

export const SAMPLE_CV_TEXT = SAMPLE_CV_TEXTS[0];

export function getRandomSampleCvText() {
  const i = Math.floor(Math.random() * SAMPLE_CV_TEXTS.length);
  return SAMPLE_CV_TEXTS[i];
}
