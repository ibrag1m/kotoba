import { Navigate, Route, Routes } from 'react-router-dom';
import { Home } from './screens/Home';
import { DeckNew } from './screens/DeckNew';
import { DeckScreen } from './screens/DeckScreen';
import { ImportScreen } from './screens/ImportScreen';
import { CardsScreen } from './screens/CardsScreen';
import { DiagScreen } from './screens/DiagScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { UpdateBanner, useUpdateAvailable } from './components/UpdateBanner';
import banner from './components/UpdateBanner.module.css';

export function App() {
  const updateAvailable = useUpdateAvailable();
  return (
    <>
      {updateAvailable && <UpdateBanner />}
      <div className={updateAvailable ? banner.below : undefined}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/deck/new" element={<DeckNew />} />
          <Route path="/deck/:id" element={<DeckScreen />} />
          <Route path="/deck/:id/import" element={<ImportScreen />} />
          <Route path="/deck/:id/cards" element={<CardsScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/diag" element={<DiagScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </>
  );
}
