import React, { useState, useEffect } from 'react';
import { User, FarmerProfile } from './types';
import { LandingPage } from './components/Landing/LandingPage';
import { FarmerAuthModal } from './components/Farmer/FarmerAuthModal';
import { OfficialAuthModal } from './components/Auth/OfficialAuthModal';
import { FarmerDashboard } from './components/Farmer/FarmerDashboard';
import { AdminDashboard } from './components/Admin/AdminDashboard';
import { OfficerDashboard } from './components/Officer/OfficerDashboard';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentFarmer, setCurrentFarmer] = useState<FarmerProfile | null>(null);

  // Modal controls
  const [farmerAuthOpen, setFarmerAuthOpen] = useState(false);
  const [adminAuthOpen, setAdminAuthOpen] = useState(false);
  const [officerAuthOpen, setOfficerAuthOpen] = useState(false);

  // Restore stored session or authenticate from farmer session link
  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        const urlParams = new URLSearchParams(window.location.search);
        const farmerIdParam = urlParams.get('farmer_id');

        if (farmerIdParam) {
          fetch(`/api/auth/farmer-session/${encodeURIComponent(farmerIdParam)}`)
            .then(res => res.json())
            .then(data => {
              if (data.success && data.user && data.farmer) {
                setCurrentUser(data.user);
                setCurrentFarmer(data.farmer);
                localStorage.setItem('agri_audit_user', JSON.stringify(data.user));
                localStorage.setItem('agri_audit_farmer', JSON.stringify(data.farmer));
              }
            })
            .catch(err => {
              console.warn('Could not auto-login from farmer parameter', err);
            });
          return;
        }
      }

      const storedUser = localStorage.getItem('agri_audit_user');
      const storedFarmer = localStorage.getItem('agri_audit_farmer');
      if (storedUser) {
        setCurrentUser(JSON.parse(storedUser));
      }
      if (storedFarmer) {
        setCurrentFarmer(JSON.parse(storedFarmer));
      }
    } catch (e) {
      console.error('Failed to restore session', e);
    }
  }, []);

  const handleFarmerSuccess = (user: User, farmer: FarmerProfile) => {
    setCurrentUser(user);
    setCurrentFarmer(farmer);
    localStorage.setItem('agri_audit_user', JSON.stringify(user));
    localStorage.setItem('agri_audit_farmer', JSON.stringify(farmer));
    setFarmerAuthOpen(false);
  };

  const handleOfficialSuccess = (user: User) => {
    setCurrentUser(user);
    setCurrentFarmer(null);
    localStorage.setItem('agri_audit_user', JSON.stringify(user));
    localStorage.removeItem('agri_audit_farmer');
    setAdminAuthOpen(false);
    setOfficerAuthOpen(false);
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setCurrentFarmer(null);
    localStorage.removeItem('agri_audit_user');
    localStorage.removeItem('agri_audit_farmer');
  };

  // Render role-specific dashboard if logged in
  if (currentUser) {
    if (currentUser.role === 'farmer' && currentFarmer) {
      return (
        <FarmerDashboard
          user={currentUser}
          farmer={currentFarmer}
          onLogout={handleLogout}
        />
      );
    }

    if (currentUser.role === 'admin') {
      return (
        <AdminDashboard
          user={currentUser}
          onLogout={handleLogout}
        />
      );
    }

    if (currentUser.role === 'officer') {
      return (
        <OfficerDashboard
          user={currentUser}
          onLogout={handleLogout}
        />
      );
    }
  }

  // Otherwise render Landing Page & Modals
  return (
    <>
      <LandingPage
        onOpenFarmerAuth={() => setFarmerAuthOpen(true)}
        onOpenAdminAuth={() => setAdminAuthOpen(true)}
        onOpenOfficerAuth={() => setOfficerAuthOpen(true)}
      />

      {/* Farmer Auth Modal (Login & Registration with Cascading Geolocation) */}
      <FarmerAuthModal
        isOpen={farmerAuthOpen}
        onClose={() => setFarmerAuthOpen(false)}
        onSuccess={handleFarmerSuccess}
      />

      {/* Admin Auth Modal */}
      <OfficialAuthModal
        isOpen={adminAuthOpen}
        onClose={() => setAdminAuthOpen(false)}
        role="admin"
        onSuccess={handleOfficialSuccess}
      />

      {/* Government Officer Auth Modal */}
      <OfficialAuthModal
        isOpen={officerAuthOpen}
        onClose={() => setOfficerAuthOpen(false)}
        role="officer"
        onSuccess={handleOfficialSuccess}
      />
    </>
  );
}
