import Foundation

extension Notification.Name {
    static let xertAPIUnauthorizedResponse = Notification.Name("com.xertfitness.api.unauthorized")
}

struct APIError: LocalizedError {
    let message: String
    let statusCode: Int?

    init(message: String, statusCode: Int? = nil) {
        self.message = message
        self.statusCode = statusCode
    }

    var errorDescription: String? { message }
    var invalidatesSession: Bool {
        statusCode.map { [400, 401, 403].contains($0) } ?? false
    }
    var isUnauthorized: Bool { statusCode == 401 }
}

enum NetworkFailureMessage {
    static func display(for code: URLError.Code) -> String {
        switch code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
            return "XERT is offline. Check your connection and try again."
        case .timedOut:
            return "XERT took too long to respond. Please try again."
        case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
            return "XERT services could not be reached. Please try again shortly."
        case .secureConnectionFailed, .serverCertificateHasBadDate,
             .serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .clientCertificateRejected,
             .clientCertificateRequired:
            return "XERT could not establish a secure connection."
        case .cancelled:
            return "The request was cancelled."
        default:
            return "The network request could not be completed. Please try again."
        }
    }
}

private struct SupabaseErrorResponse: Decodable {
    let message: String?
    let error: String?
    let error_description: String?
    let request_id: String?

    var displayMessage: String? {
        guard let message = message ?? error_description ?? error else { return nil }
        guard let requestID = request_id.flatMap(UUID.init(uuidString:)) else { return message }
        return "\(message) Reference: \(requestID.uuidString.prefix(8).lowercased())."
    }
}

final class XertAPI {
    private let session: URLSession
    private let decoder: JSONDecoder

    init(session: URLSession = .shared) {
        self.session = session
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            if let date = ISO8601DateFormatter.withFractionalSeconds.date(from: value) {
                return date
            }
            if let date = ISO8601DateFormatter.standard.date(from: value) {
                return date
            }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Invalid date: \(value)")
            )
        }
    }

    func signIn(email: String, password: String) async throws -> AuthSession {
        let body = ["email": email, "password": password]
        let response: AuthResponse = try await authRequest(
            path: "/auth/v1/token",
            queryItems: [URLQueryItem(name: "grant_type", value: "password")],
            body: body
        )
        guard let session = response.session else {
            throw APIError(message: "Supabase did not return a session.")
        }
        return session
    }

    func signUp(_ signUp: MemberSignUpRequest) async throws -> AuthSession? {
        let response: AuthResponse = try await authRequest(path: "/auth/v1/signup", body: signUp)
        return response.session
    }

    func requestPasswordReset(email: String) async throws {
        let _: EmptyObject = try await authRequest(
            path: "/auth/v1/recover",
            queryItems: [URLQueryItem(name: "redirect_to", value: AppConfig.webURL(path: "reset-password").absoluteString)],
            body: ["email": email]
        )
    }

    func refresh(session auth: AuthSession) async throws -> AuthSession {
        guard let refreshToken = auth.refresh_token, !refreshToken.isEmpty else {
            throw APIError(message: "Your XERT session needs you to sign in again.")
        }
        let response: AuthResponse = try await authRequest(
            path: "/auth/v1/token",
            queryItems: [URLQueryItem(name: "grant_type", value: "refresh_token")],
            body: ["refresh_token": refreshToken]
        )
        guard let session = response.session else {
            throw APIError(message: "Supabase did not return a refreshed session.")
        }
        return session
    }

    func signOut(session auth: AuthSession) async throws {
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/auth/v1/logout")
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        try await perform(request)
    }

    func updatePassword(session auth: AuthSession, request body: PasswordUpdateRequest) async throws {
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/auth/v1/user")
        request.httpMethod = "PUT"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        try await perform(request)
    }

    func products() async throws -> [Product] {
        try await restRequest(
            path: "/rest/v1/products",
            queryItems: [
                URLQueryItem(name: "select", value: "*"),
                URLQueryItem(name: "active", value: "eq.true"),
                URLQueryItem(name: "order", value: "sort_order.asc")
            ]
        )
    }

    func publicPlatformSettings() async throws -> PublicPlatformSettings? {
        let settings: [PublicPlatformSettings] = try await restRequest(
            path: "/rest/v1/admin_settings",
            queryItems: [
                URLQueryItem(name: "select", value: "bookings_enabled,payments_enabled,prices_coming_soon,fitbox_enabled,fitbox_booking_url"),
                URLQueryItem(name: "limit", value: "2")
            ]
        )
        return settings.count == 1 ? settings[0] : nil
    }

    func sessions() async throws -> [ClassSession] {
        try await rpc(path: "sessions_with_availability", body: EmptyBody())
    }

    func events() async throws -> [EventItem] {
        try await restRequest(
            path: "/rest/v1/events",
            queryItems: [
                URLQueryItem(name: "select", value: "*"),
                URLQueryItem(name: "published", value: "eq.true"),
                URLQueryItem(name: "order", value: "event_date.asc,sort_order.asc")
            ]
        )
    }

    func eventGoals(session auth: AuthSession) async throws -> [EventGoal] {
        try await restRequest(
            path: "/rest/v1/member_event_goals",
            queryItems: [
                URLQueryItem(name: "select", value: "event_id"),
                URLQueryItem(name: "order", value: "created_at.desc")
            ],
            auth: auth
        )
    }

    func addEventGoal(session auth: AuthSession, eventID: UUID) async throws {
        guard let userID = auth.user?.id else {
            throw APIError(message: "Your XERT session needs you to sign in again.")
        }
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/member_event_goals",
            queryItems: [URLQueryItem(name: "on_conflict", value: "user_id,event_id")]
        )
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("resolution=ignore-duplicates,return=minimal", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(EventGoalMutation(user_id: userID, event_id: eventID))
        try await perform(request)
    }

    func removeEventGoal(session auth: AuthSession, eventID: UUID) async throws {
        guard let userID = auth.user?.id else {
            throw APIError(message: "Your XERT session needs you to sign in again.")
        }
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/member_event_goals",
            queryItems: [
                URLQueryItem(name: "user_id", value: "eq.\(userID.uuidString)"),
                URLQueryItem(name: "event_id", value: "eq.\(eventID.uuidString)")
            ]
        )
        request.httpMethod = "DELETE"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        try await perform(request)
    }

    func credits(session auth: AuthSession, now: Date = Date()) async throws -> [CreditBatch] {
        let timestamp = ISO8601DateFormatter.standard.string(from: now)
        return try await restRequest(
            path: "/rest/v1/credit_batches",
            queryItems: [
                URLQueryItem(name: "select", value: "id,order_id,total,remaining,expires_at"),
                URLQueryItem(name: "or", value: "(expires_at.is.null,expires_at.gt.\(timestamp))"),
                URLQueryItem(name: "order", value: "expires_at.asc")
            ],
            auth: auth
        )
    }

    func orders(session auth: AuthSession) async throws -> [OrderItem] {
        try await restRequest(
            path: "/rest/v1/orders",
            queryItems: [
                URLQueryItem(name: "select", value: "id,user_id,product_id,email,status,amount_cents,currency,credit_total,credit_validity_days,stripe_checkout_session_id,stripe_payment_intent_id,created_at,paid_at,refunded_at,refunded_amount_cents,reconciled_at,reconciled_by,products(name),stripe_refunds(refund_id,amount_cents,credits_revoked,credits_consumed,bookings_cancelled,refunded_at)"),
                URLQueryItem(name: "order", value: "created_at.desc")
            ],
            auth: auth
        )
    }

    func adminOrders(session auth: AuthSession) async throws -> [OrderItem] {
        let pageSize = 500
        var offset = 0
        var orders: [OrderItem] = []
        while true {
            let page: [OrderItem] = try await restRequest(
                path: "/rest/v1/orders",
                queryItems: [
                    URLQueryItem(name: "select", value: "id,user_id,product_id,email,status,amount_cents,currency,credit_total,credit_validity_days,stripe_checkout_session_id,stripe_payment_intent_id,created_at,paid_at,refunded_at,refunded_amount_cents,reconciled_at,reconciled_by,products(name),stripe_refunds(refund_id,amount_cents,credits_revoked,credits_consumed,bookings_cancelled,refunded_at)"),
                    URLQueryItem(name: "order", value: "created_at.desc,id.desc"),
                    URLQueryItem(name: "limit", value: String(pageSize)),
                    URLQueryItem(name: "offset", value: String(offset))
                ],
                auth: auth
            )
            orders.append(contentsOf: page)
            if page.count < pageSize { return orders }
            offset += pageSize
        }
    }

    func adminOrder(session auth: AuthSession, id: UUID) async throws -> OrderItem {
        let rows: [OrderItem] = try await restRequest(
            path: "/rest/v1/orders",
            queryItems: [
                URLQueryItem(name: "select", value: "id,user_id,product_id,email,status,amount_cents,currency,credit_total,credit_validity_days,stripe_checkout_session_id,stripe_payment_intent_id,created_at,paid_at,refunded_at,refunded_amount_cents,reconciled_at,reconciled_by,products(name),stripe_refunds(refund_id,amount_cents,credits_revoked,credits_consumed,bookings_cancelled,refunded_at)"),
                URLQueryItem(name: "id", value: "eq.\(id.uuidString)"),
                URLQueryItem(name: "limit", value: "1")
            ],
            auth: auth
        )
        guard rows.count == 1, rows[0].id == id else {
            throw APIError(message: "This order is no longer available to your administrator account.")
        }
        return rows[0]
    }

    func adminReconcileOrder(session auth: AuthSession, orderID: UUID) async throws -> AdminReconciliationResult {
        try await vercelRequest(
            path: "/api/admin-reconcile-order",
            body: AdminOrderRequest(order_id: orderID),
            auth: auth
        )
    }

    func adminRefundOrder(
        session auth: AuthSession,
        orderID: UUID,
        reason: String,
        confirmation: String
    ) async throws -> AdminRefundResult {
        guard ["requested_by_customer", "duplicate"].contains(reason) else {
            throw APIError(message: "Choose a valid refund reason.")
        }
        guard confirmation == "REFUND" else {
            throw APIError(message: "Type REFUND exactly to confirm this full refund.")
        }
        return try await vercelRequest(
            path: "/api/admin-refund-order",
            body: AdminRefundRequest(order_id: orderID, reason: reason, confirmation: confirmation),
            auth: auth
        )
    }

    func announcements(session auth: AuthSession) async throws -> [MemberAnnouncement] {
        try await rpc(path: "my_member_announcements", body: EmptyBody(), auth: auth)
    }

    func dismissAnnouncement(session auth: AuthSession, announcementID: UUID) async throws {
        let _: EmptyResponse = try await rpc(
            path: "dismiss_member_announcement",
            body: ["p_announcement_id": announcementID.uuidString],
            auth: auth
        )
    }

    func profile(session auth: AuthSession) async throws -> MemberProfile? {
        var queryItems = [
            URLQueryItem(name: "select", value: "id,full_name,phone,email,role"),
            URLQueryItem(name: "limit", value: "1"),
        ]
        if let userID = auth.user?.id {
            queryItems.append(URLQueryItem(name: "id", value: "eq.\(userID.uuidString)"))
        }
        let profiles: [MemberProfile] = try await restRequest(
            path: "/rest/v1/profiles",
            queryItems: queryItems,
            auth: auth
        )
        return profiles.first
    }

    func memberOnboarding(session auth: AuthSession) async throws -> MemberOnboardingState {
        try await rpc(
            path: "my_member_onboarding",
            body: EmptyBody(),
            auth: auth
        )
    }

    // MARK: - Native admin command centre

    func adminDailyOperations(session auth: AuthSession) async throws -> [AdminDailyOperation] {
        try await rpc(path: "admin_daily_operations", body: EmptyBody(), auth: auth)
    }

    func adminWaitlist(session auth: AuthSession, limit: Int = 20) async throws -> [AdminWaitlistItem] {
        try await rpc(
            path: "admin_waitlist_overview",
            body: AdminLimitRequest(p_limit: min(max(limit, 1), 50)),
            auth: auth
        )
    }

    func adminSessionRoster(session auth: AuthSession, classSessionID: UUID) async throws -> [AdminRosterMember] {
        try await rpc(
            path: "admin_session_roster",
            body: AdminSessionRequest(p_session_id: classSessionID),
            auth: auth
        )
    }

    func adminClassCancellationEnquiries(
        session auth: AuthSession,
        classSessionID: UUID
    ) async throws -> [AdminLegacyBookingRequest] {
        try await adminClassBookings(
            session: auth,
            classSessionID: classSessionID,
            statuses: ["requested", "confirmed", "waitlisted"]
        )
    }

    /// Everyone who signed up for one class from the public timetable, whatever
    /// their status. The web SMS screen texts these people alongside the member
    /// roster; passing no statuses keeps the two platforms addressing the same
    /// list rather than the app quietly finding nobody.
    func adminClassSignups(
        session auth: AuthSession,
        classSessionID: UUID
    ) async throws -> [AdminLegacyBookingRequest] {
        try await adminClassBookings(session: auth, classSessionID: classSessionID, statuses: nil)
    }

    private func adminClassBookings(
        session auth: AuthSession,
        classSessionID: UUID,
        statuses: [String]?
    ) async throws -> [AdminLegacyBookingRequest] {
        let pageSize = 500
        var offset = 0
        var enquiries: [AdminLegacyBookingRequest] = []
        while true {
            var queryItems = [
                URLQueryItem(name: "select", value: "id,full_name,email,phone,status,admin_notes,created_at"),
                URLQueryItem(name: "class_session_id", value: "eq.\(classSessionID.uuidString)"),
                URLQueryItem(name: "order", value: "created_at.asc,id.asc"),
                URLQueryItem(name: "limit", value: String(pageSize)),
                URLQueryItem(name: "offset", value: String(offset))
            ]
            if let statuses, !statuses.isEmpty {
                queryItems.insert(
                    URLQueryItem(name: "status", value: "in.(\(statuses.joined(separator: ",")))"),
                    at: 2
                )
            }
            let page: [AdminLegacyBookingRequest] = try await restRequest(
                path: "/rest/v1/class_bookings",
                queryItems: queryItems,
                auth: auth
            )
            enquiries.append(contentsOf: page)
            if page.count < pageSize { return enquiries }
            offset += pageSize
        }
    }

    func adminClassSessions(session auth: AuthSession) async throws -> [AdminClassSession] {
        return try await restRequest(
            path: "/rest/v1/class_sessions",
            queryItems: [
                URLQueryItem(name: "select", value: "id,class_type,title,description,coach_name,start_time,end_time,duration_minutes,capacity,location_zone,beginner_friendly,intensity_level,status,public_visible,booking_mode,notes"),
                URLQueryItem(name: "order", value: "start_time.asc.nullslast"),
                URLQueryItem(name: "limit", value: "1000")
            ],
            auth: auth
        )
    }

    func adminClassTemplates(session auth: AuthSession) async throws -> [AdminClassTemplate] {
        return try await restRequest(
            path: "/rest/v1/class_templates",
            queryItems: [
                URLQueryItem(name: "select", value: "id,name,class_type,title,description,coach_name,duration_minutes,capacity,location_zone,beginner_friendly,intensity_level,booking_mode,default_start_minute,notes"),
                URLQueryItem(name: "order", value: "name.asc"),
                URLQueryItem(name: "limit", value: "200")
            ],
            auth: auth
        )
    }

    @discardableResult
    func adminCreateClass(session auth: AuthSession, draft: AdminClassDraft) async throws -> UUID {
        let payload = try adminClassPayload(draft)
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/rest/v1/class_sessions")
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(payload)
        let rows: [AdminMutationID] = try await decode(request)
        guard let created = rows.first, rows.count == 1 else {
            throw APIError(message: "XERT could not confirm the created class.")
        }
        return created.id
    }

    @discardableResult
    func adminCreateClasses(
        session auth: AuthSession,
        drafts: [AdminClassDraft]
    ) async throws -> [UUID] {
        guard (AdminClassRepeatPlan.minimumCopies...AdminClassRepeatPlan.maximumCopies).contains(drafts.count) else {
            throw APIError(
                message: "Create between \(AdminClassRepeatPlan.minimumCopies) and \(AdminClassRepeatPlan.maximumCopies) class copies."
            )
        }
        let payloads = try drafts.map(adminClassPayload)
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/rest/v1/class_sessions")
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(payloads)

        let rows: [AdminMutationID] = try await decode(request)
        let ids = rows.map(\.id)
        guard ids.count == drafts.count, Set(ids).count == drafts.count else {
            throw APIError(
                message: "XERT could not confirm the complete repeat block. Refresh the timetable before trying again."
            )
        }
        return ids
    }

    @discardableResult
    func adminUpdateClass(session auth: AuthSession, classSession: AdminClassSession, draft: AdminClassDraft) async throws -> UUID {
        guard !["cancelled", "completed"].contains(classSession.status) else {
            throw APIError(message: "Cancelled and completed classes cannot be reopened. Create a new class instead.")
        }
        guard !["cancelled", "completed"].contains(draft.status) else {
            throw APIError(message: "Use cancellation or attendance to close this class safely.")
        }
        return try await rpc(
            path: "admin_update_class_session",
            body: AdminClassUpdateRequest(
                p_session_id: classSession.id,
                p_session: try adminClassPayload(draft)
            ),
            auth: auth
        )
    }

    @discardableResult
    func adminCancelClass(session auth: AuthSession, classSessionID: UUID) async throws -> Int {
        try await rpc(
            path: "admin_cancel_class_session",
            body: AdminSessionRequest(p_session_id: classSessionID),
            auth: auth
        )
    }

    func adminNotifyClassCancellation(
        session auth: AuthSession,
        classSessionID: UUID
    ) async throws -> AdminClassCancellationNoticeOutcome {
        try await vercelRequest(
            path: "/api/admin-publish-announcement",
            body: AdminCancellationNoticeRequest(action: "notify_class_cancellation", session_id: classSessionID),
            auth: auth
        )
    }

    private func adminClassPayload(_ draft: AdminClassDraft) throws -> AdminClassPayload {
        let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw APIError(message: "A class title is required.") }
        guard AdminClassDraft.classTypes.contains(draft.classType) else { throw APIError(message: "Choose a valid class type.") }
        guard AdminClassDraft.intensities.contains(draft.intensity) else { throw APIError(message: "Choose a valid intensity.") }
        guard AdminClassDraft.bookingModes.contains(draft.bookingMode) else { throw APIError(message: "Choose a valid booking mode.") }
        guard ["draft", "published", "full"].contains(draft.status) else { throw APIError(message: "Choose a valid editable class status.") }
        guard draft.capacity > 0, draft.durationMinutes > 0 else { throw APIError(message: "Capacity and duration must be positive whole numbers.") }
        if draft.status == "published" && draft.startTime <= Date() {
            throw APIError(message: "A published class must start in the future.")
        }
        if draft.hasEndTime && draft.endTime <= draft.startTime {
            throw APIError(message: "Class end time must be after its start time.")
        }
        return AdminClassPayload(
            class_type: draft.classType,
            title: title,
            description: draft.description.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            coach_name: draft.coachName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            start_time: ISO8601DateFormatter.standard.string(from: draft.startTime),
            end_time: draft.hasEndTime ? ISO8601DateFormatter.standard.string(from: draft.endTime) : nil,
            duration_minutes: draft.durationMinutes,
            capacity: draft.capacity,
            location_zone: draft.location.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            beginner_friendly: draft.beginnerFriendly,
            intensity_level: draft.intensity,
            status: draft.status,
            // 'full' is a live, listed class — the timetable shows its Full badge
            // and offers the waitlist. Dropping it out of public view here deleted
            // the class from the timetable instead, taking its waitlist with it,
            // every time the owner saved a class they had marked Full.
            public_visible: ["published", "full"].contains(draft.status) && draft.publicVisible,
            booking_mode: draft.bookingMode,
            notes: draft.notes.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        )
    }

    func adminAvailabilityBlocks(session auth: AuthSession) async throws -> [AdminAvailabilityBlock] {
        try await restRequest(
            path: "/rest/v1/availability_blocks",
            queryItems: [
                URLQueryItem(name: "select", value: "id,start_time,end_time,type,coach_name,notes,is_bookable,updated_at"),
                URLQueryItem(name: "order", value: "start_time.asc")
            ], auth: auth
        )
    }

    func adminBlackoutPeriods(session auth: AuthSession) async throws -> [AdminBlackoutPeriod] {
        try await restRequest(
            path: "/rest/v1/blackout_periods",
            queryItems: [
                URLQueryItem(name: "select", value: "id,start_time,end_time,affects,reason,notes,updated_at"),
                URLQueryItem(name: "order", value: "start_time.asc")
            ], auth: auth
        )
    }

    func adminSaveAvailability(session auth: AuthSession, block: AdminAvailabilityBlock?, draft: AdminAvailabilityDraft) async throws -> AdminAvailabilityBlock {
        guard AdminAvailabilityDraft.types.contains(draft.type) else { throw APIError(message: "Choose a valid availability type.") }
        guard draft.endTime > draft.startTime else { throw APIError(message: "Availability must end after it starts.") }
        let payload = AdminAvailabilityPayload(
            start_time: ISO8601DateFormatter.standard.string(from: draft.startTime),
            end_time: ISO8601DateFormatter.standard.string(from: draft.endTime),
            type: draft.type,
            coach_name: draft.coachName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            notes: draft.notes.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            is_bookable: draft.isBookable
        )
        return try await adminScheduleMutation(
            path: "/rest/v1/availability_blocks",
            id: block?.id,
            version: block?.updated_at,
            payload: payload,
            auth: auth
        )
    }

    func adminSaveBlackout(session auth: AuthSession, period: AdminBlackoutPeriod?, draft: AdminBlackoutDraft) async throws -> AdminBlackoutPeriod {
        guard AdminBlackoutDraft.scopes.contains(draft.affects) else { throw APIError(message: "Choose a valid blackout scope.") }
        guard AdminBlackoutDraft.reasons.contains(draft.reason) else { throw APIError(message: "Choose a valid blackout reason.") }
        guard draft.endTime > draft.startTime else { throw APIError(message: "Blackout must end after it starts.") }
        let payload = AdminBlackoutPayload(
            start_time: ISO8601DateFormatter.standard.string(from: draft.startTime),
            end_time: ISO8601DateFormatter.standard.string(from: draft.endTime),
            affects: draft.affects,
            reason: draft.reason,
            notes: draft.notes.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        )
        do {
            return try await adminScheduleMutation(
                path: "/rest/v1/blackout_periods",
                id: period?.id,
                version: period?.updated_at,
                payload: payload,
                auth: auth
            )
        } catch let error as APIError where error.message.localizedCaseInsensitiveContains("BLACKOUT_OVERLAPS_PUBLISHED_CLASS") {
            throw APIError(message: "This blackout overlaps a published class. Cancel or reschedule that class first.")
        }
    }

    func adminDeleteAvailability(session auth: AuthSession, block: AdminAvailabilityBlock) async throws -> UUID {
        try await adminScheduleDelete(path: "/rest/v1/availability_blocks", id: block.id, version: block.updated_at, auth: auth)
    }

    func adminDeleteBlackout(session auth: AuthSession, period: AdminBlackoutPeriod) async throws -> UUID {
        try await adminScheduleDelete(path: "/rest/v1/blackout_periods", id: period.id, version: period.updated_at, auth: auth)
    }

    private func adminScheduleMutation<Record: Decodable, Payload: Encodable>(
        path: String,
        id: UUID?,
        version: String?,
        payload: Payload,
        auth: AuthSession
    ) async throws -> Record {
        var queryItems: [URLQueryItem] = []
        if id != nil && version == nil {
            throw APIError(message: "This schedule record has no version. Refresh before editing it.")
        }
        if let id, let version {
            queryItems = [URLQueryItem(name: "id", value: "eq.\(id.uuidString)"), URLQueryItem(name: "updated_at", value: "eq.\(version)")]
        }
        var request = try request(baseURL: AppConfig.supabaseURL, path: path, queryItems: queryItems)
        request.httpMethod = id == nil ? "POST" : "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(payload)
        let rows: [Record] = try await decode(request)
        guard rows.count == 1, let record = rows.first else {
            throw APIError(message: "No exact schedule change was confirmed. Refresh and review the latest records.")
        }
        return record
    }

    private func adminScheduleDelete(path: String, id: UUID, version: String, auth: AuthSession) async throws -> UUID {
        var request = try request(baseURL: AppConfig.supabaseURL, path: path, queryItems: [
            URLQueryItem(name: "id", value: "eq.\(id.uuidString)"), URLQueryItem(name: "updated_at", value: "eq.\(version)")
        ])
        request.httpMethod = "DELETE"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        let rows: [AdminMutationID] = try await decode(request)
        guard rows.count == 1, rows[0].id == id else {
            throw APIError(message: "This schedule record changed elsewhere. Refresh before removing it.")
        }
        return id
    }

    @discardableResult
    func adminSetBookingStatus(session auth: AuthSession, bookingID: UUID, status: String) async throws -> AdminBookingDecisionOutcome {
        guard ["requested", "confirmed", "waitlisted", "cancelled", "declined", "attended", "no_show"].contains(status) else {
            throw APIError(message: "Choose a valid booking decision.")
        }
        let rows: [AdminBookingDecision] = try await rpc(
            path: "admin_set_booking_status_with_notice",
            body: AdminBookingStatusRequest(
                p_booking_id: bookingID,
                p_status: status,
                p_request_id: UUID()
            ),
            auth: auth
        )
        guard rows.count == 1, let decision = rows.first,
              decision.booking_id == bookingID, decision.new_status == status else {
            throw APIError(message: "The booking decision completed without a verifiable receipt. Refresh before continuing.")
        }
        guard let announcementID = decision.announcement_id else {
            return AdminBookingDecisionOutcome(decision: decision, pushDelivered: false, warning: nil)
        }
        do {
            let response: AdminTargetedNoticeResponse = try await vercelRequest(
                path: "/api/admin-publish-announcement",
                body: AdminTargetedNoticeRequest(
                    action: "notify_targeted_announcement",
                    announcement_id: announcementID
                ),
                auth: auth
            )
            return AdminBookingDecisionOutcome(
                decision: decision,
                pushDelivered: (response.push?.delivered ?? 0) > 0,
                warning: response.push?.configured == false
                    ? "The booking was updated and the member's private notice is live, but Apple push is not configured."
                    : nil
            )
        } catch {
            return AdminBookingDecisionOutcome(
                decision: decision,
                pushDelivered: false,
                warning: "The booking was updated and the member's private notice is live, but Apple push delivery needs attention."
            )
        }
    }

    /// Sends an SMS campaign through the admin communications function.
    /// Twilio credentials stay server-side; the app only supplies recipients.
    func adminSendSMS(
        session auth: AuthSession,
        message: String,
        recipients: [SmsCampaign.Recipient]
    ) async throws -> AdminSmsOutcome {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if let problem = SmsCampaign.validationMessage(message: trimmed, recipients: recipients) {
            throw APIError(message: problem)
        }
        return try await vercelRequest(
            path: "/api/admin-publish-announcement",
            body: AdminSmsSendRequest(
                action: "send_sms",
                message: trimmed,
                recipients: recipients.map {
                    AdminSmsRecipientPayload(name: $0.name, phone: $0.phone)
                }
            ),
            auth: auth
        )
    }

    func adminBookMemberIntoClass(
        session auth: AuthSession,
        classSessionID: UUID,
        memberID: UUID,
        requestID: UUID
    ) async throws -> AdminStaffBookingOutcome {
        let rows: [AdminStaffBookingReceipt] = try await rpc(
            path: "admin_book_member_into_class",
            body: AdminStaffBookingRequest(
                p_session_id: classSessionID,
                p_member_id: memberID,
                p_request_id: requestID
            ),
            auth: auth
        )
        guard rows.count == 1, let receipt = rows.first,
              receipt.request_id == requestID,
              receipt.session_id == classSessionID,
              receipt.member_id == memberID,
              ["confirmed", "waitlisted"].contains(receipt.booking_status) else {
            throw APIError(
                message: "The staff booking completed without a verifiable receipt. Refresh the roster before continuing."
            )
        }
        guard let announcementID = receipt.announcement_id else {
            return AdminStaffBookingOutcome(
                receipt: receipt,
                pushDelivered: false,
                warning: "The roster changed, but no private member notice was returned."
            )
        }
        do {
            let response: AdminTargetedNoticeResponse = try await vercelRequest(
                path: "/api/admin-publish-announcement",
                body: AdminTargetedNoticeRequest(
                    action: "notify_targeted_announcement",
                    announcement_id: announcementID
                ),
                auth: auth
            )
            return AdminStaffBookingOutcome(
                receipt: receipt,
                pushDelivered: (response.push?.delivered ?? 0) > 0,
                warning: response.push?.configured == false
                    ? "The private notice is live, but Apple push is not configured."
                    : nil
            )
        } catch {
            return AdminStaffBookingOutcome(
                receipt: receipt,
                pushDelivered: false,
                warning: "The private notice is live, but Apple push delivery needs attention."
            )
        }
    }

    @discardableResult
    func adminRecordAttendance(
        session auth: AuthSession,
        classSessionID: UUID,
        attendedIDs: [UUID],
        noShowIDs: [UUID]
    ) async throws -> Int {
        guard !attendedIDs.isEmpty || !noShowIDs.isEmpty else {
            throw APIError(message: "Complete the roll call before saving attendance.")
        }
        return try await rpc(
            path: "admin_record_session_attendance",
            body: AdminAttendanceRequest(
                p_session_id: classSessionID,
                p_attended_ids: attendedIDs,
                p_no_show_ids: noShowIDs
            ),
            auth: auth
        )
    }

    func adminFollowUps(session auth: AuthSession, limit: Int = 20) async throws -> [AdminFollowUp] {
        try await rpc(
            path: "admin_member_follow_up_queue",
            body: AdminLimitRequest(p_limit: min(max(limit, 1), 50)),
            auth: auth
        )
    }

    func adminMembers(
        session auth: AuthSession,
        search: String = "",
        role: String = "all",
        credit: String = "all",
        limit: Int = 50,
        offset: Int = 0
    ) async throws -> [AdminMemberSummary] {
        let normalizedRole = ["member", "admin"].contains(role) ? role : "all"
        let normalizedCredit = ["available", "none"].contains(credit) ? credit : "all"
        return try await rpc(
            path: "admin_list_members_page",
            body: AdminMemberPageRequest(
                p_search: search.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                p_role: normalizedRole,
                p_credit: normalizedCredit,
                p_limit: min(max(limit, 1), 100),
                p_offset: max(offset, 0),
                p_user_id: nil
            ),
            auth: auth
        )
    }

    func adminMember(session auth: AuthSession, id: UUID) async throws -> AdminMemberSummary {
        let rows: [AdminMemberSummary] = try await rpc(
            path: "admin_list_members_page",
            body: AdminMemberPageRequest(
                p_search: nil,
                p_role: "all",
                p_credit: "all",
                p_limit: 1,
                p_offset: 0,
                p_user_id: id
            ),
            auth: auth
        )
        guard rows.count == 1, rows[0].id == id else {
            throw APIError(message: "This member record is no longer available.")
        }
        return rows[0]
    }

    func adminMemberNotes(session auth: AuthSession, memberID: UUID, includeArchived: Bool = true) async throws -> [AdminMemberNote] {
        try await rpc(
            path: "admin_list_member_notes",
            body: AdminMemberNotesRequest(p_user_id: memberID, p_include_archived: includeArchived),
            auth: auth
        )
    }

    func adminMemberNotices(session auth: AuthSession, memberID: UUID) async throws -> [AdminMemberNotice] {
        try await rpc(
            path: "admin_list_member_notices",
            body: AdminMemberIDRequest(p_user_id: memberID),
            auth: auth
        )
    }

    func adminMemberCreditBatches(
        session auth: AuthSession,
        memberID: UUID
    ) async throws -> [AdminMemberCreditBatch] {
        try await restRequest(
            path: "/rest/v1/credit_batches",
            queryItems: [
                URLQueryItem(name: "select", value: "id,order_id,total,remaining,expires_at,created_at"),
                URLQueryItem(name: "user_id", value: "eq.\(memberID.uuidString)"),
                URLQueryItem(name: "order", value: "created_at.desc,id.desc"),
                URLQueryItem(name: "limit", value: "50")
            ],
            auth: auth
        )
    }

    func adminMemberCreditGrants(
        session auth: AuthSession,
        memberID: UUID
    ) async throws -> [AdminMemberCreditGrant] {
        try await restRequest(
            path: "/rest/v1/admin_credit_grants",
            queryItems: [
                URLQueryItem(name: "select", value: "id,sessions,validity_days,note,credit_batch_id,created_at"),
                URLQueryItem(name: "user_id", value: "eq.\(memberID.uuidString)"),
                URLQueryItem(name: "order", value: "created_at.desc,id.desc"),
                URLQueryItem(name: "limit", value: "50")
            ],
            auth: auth
        )
    }

    func adminMemberBookings(
        session auth: AuthSession,
        memberID: UUID
    ) async throws -> [AdminMemberBookingHistory] {
        try await restRequest(
            path: "/rest/v1/session_bookings",
            queryItems: [
                URLQueryItem(name: "select", value: "id,status,created_at,cancelled_at,class_sessions(title,class_type,start_time)"),
                URLQueryItem(name: "user_id", value: "eq.\(memberID.uuidString)"),
                URLQueryItem(name: "order", value: "created_at.desc,id.desc"),
                URLQueryItem(name: "limit", value: "50")
            ],
            auth: auth
        )
    }

    func adminMemberOrders(
        session auth: AuthSession,
        memberID: UUID
    ) async throws -> [OrderItem] {
        try await restRequest(
            path: "/rest/v1/orders",
            queryItems: [
                URLQueryItem(name: "select", value: "id,user_id,product_id,email,status,amount_cents,currency,credit_total,credit_validity_days,stripe_checkout_session_id,stripe_payment_intent_id,created_at,paid_at,refunded_at,refunded_amount_cents,reconciled_at,reconciled_by,products(name),stripe_refunds(refund_id,amount_cents,credits_revoked,credits_consumed,bookings_cancelled,refunded_at)"),
                URLQueryItem(name: "user_id", value: "eq.\(memberID.uuidString)"),
                URLQueryItem(name: "order", value: "created_at.desc,id.desc"),
                URLQueryItem(name: "limit", value: "50")
            ],
            auth: auth
        )
    }

    func adminSendMemberNotice(
        session auth: AuthSession,
        memberID: UUID,
        draft: AdminMemberNoticeDraft,
        now: Date = Date()
    ) async throws -> AdminMemberNoticeSendOutcome {
        if let message = draft.validationMessage() {
            throw APIError(message: message)
        }
        let action = draft.action.cta
        guard let expiresAt = Calendar(identifier: .gregorian).date(
            byAdding: .day,
            value: draft.expiryDays,
            to: now
        ) else {
            throw APIError(message: "The notice expiry could not be calculated.")
        }
        let announcementID: UUID = try await rpc(
            path: "admin_send_member_notice",
            body: AdminMemberNoticeRequest(
                p_user_id: memberID,
                p_title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
                p_body: draft.body.trimmingCharacters(in: .whitespacesAndNewlines),
                p_tone: draft.tone,
                p_cta_label: action.label,
                p_cta_url: action.url,
                p_expires_at: ISO8601DateFormatter.standard.string(from: expiresAt)
            ),
            auth: auth
        )
        do {
            let response: AdminTargetedNoticeResponse = try await vercelRequest(
                path: "/api/admin-publish-announcement",
                body: AdminTargetedNoticeRequest(
                    action: "notify_targeted_announcement",
                    announcement_id: announcementID
                ),
                auth: auth
            )
            let warning = response.push?.configured == false
                ? "The notice is live in the member app, but Apple push is not configured."
                : nil
            return AdminMemberNoticeSendOutcome(
                announcementID: announcementID,
                push: response.push.map {
                    AdminAnnouncementPushSummary(
                        configured: $0.configured,
                        attempted: $0.attempted,
                        delivered: $0.delivered,
                        failed: $0.failed
                    )
                },
                warning: warning
            )
        } catch {
            return AdminMemberNoticeSendOutcome(
                announcementID: announcementID,
                push: nil,
                warning: "The notice is live in the member app, but Apple push delivery needs attention."
            )
        }
    }

    func adminMemberActivationOverview(
        session auth: AuthSession,
        cohortDays: Int = 30
    ) async throws -> AdminMemberActivationOverview {
        let rows: [AdminMemberActivationOverview] = try await rpc(
            path: "admin_member_activation_overview",
            body: AdminCohortDaysRequest(p_cohort_days: min(max(cohortDays, 1), 3_650)),
            auth: auth
        )
        guard rows.count == 1 else {
            throw APIError(message: "Member activation returned an incomplete cohort summary.")
        }
        return rows[0]
    }

    func adminMemberActivationQueue(
        session auth: AuthSession,
        limit: Int = 12
    ) async throws -> [AdminMemberActivationItem] {
        try await rpc(
            path: "admin_member_activation_queue",
            body: AdminLimitRequest(p_limit: min(max(limit, 1), 100)),
            auth: auth
        )
    }

    func adminMemberOnboardingSummaries(
        session auth: AuthSession,
        memberIDs: [UUID]
    ) async throws -> [AdminMemberOnboardingSummary] {
        let uniqueIDs = Array(Set(memberIDs))
        guard !uniqueIDs.isEmpty else { return [] }
        var summaries: [AdminMemberOnboardingSummary] = []
        for start in stride(from: 0, to: uniqueIDs.count, by: 100) {
            let end = min(start + 100, uniqueIDs.count)
            let rows: [AdminMemberOnboardingSummary] = try await rpc(
                path: "admin_member_onboarding_summary",
                body: AdminMemberIDsRequest(p_user_ids: Array(uniqueIDs[start..<end])),
                auth: auth
            )
            summaries.append(contentsOf: rows)
        }
        let returnedIDs = Set(summaries.map(\.user_id))
        guard summaries.count == uniqueIDs.count, returnedIDs == Set(uniqueIDs) else {
            throw APIError(message: "Readiness could not be verified for every roster member.")
        }
        return summaries
    }

    func adminMemberOnboardingSummary(session auth: AuthSession, memberID: UUID) async throws -> AdminMemberOnboardingSummary {
        let rows = try await adminMemberOnboardingSummaries(session: auth, memberIDs: [memberID])
        guard rows.count == 1, rows[0].user_id == memberID else {
            throw APIError(message: "Member readiness is not available for this account.")
        }
        return rows[0]
    }

    func adminRevealMemberEmergencyContact(session auth: AuthSession, memberID: UUID) async throws -> AdminMemberEmergencyContactReveal {
        try await rpc(
            path: "admin_reveal_member_emergency_contact",
            body: AdminMemberIDRequest(p_user_id: memberID),
            auth: auth
        )
    }

    @discardableResult
    func adminGrantCredits(
        session auth: AuthSession,
        memberID: UUID,
        sessions: Int,
        validityDays: Int?,
        requestID: UUID,
        note: String
    ) async throws -> UUID {
        let reason = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...100).contains(sessions) else { throw APIError(message: "Grant between 1 and 100 class credits.") }
        if let validityDays, !(1...3_650).contains(validityDays) { throw APIError(message: "Validity must be between 1 and 3,650 days.") }
        guard (3...500).contains(reason.count) else { throw APIError(message: "Add a grant reason between 3 and 500 characters.") }
        return try await rpc(
            path: "admin_grant_credits_v2",
            body: AdminCreditGrantRequest(
                p_user_id: memberID, p_sessions: sessions, p_validity_days: validityDays,
                p_request_id: requestID, p_note: reason
            ), auth: auth
        )
    }

    func adminSetRole(session auth: AuthSession, memberID: UUID, role: String) async throws {
        guard ["member", "admin"].contains(role) else { throw APIError(message: "Choose a valid account role.") }
        do {
            let _: EmptyResponse = try await rpc(
                path: "admin_set_role",
                body: AdminRoleRequest(p_user_id: memberID, p_role: role), auth: auth
            )
        } catch let error as APIError {
            if error.message.localizedCaseInsensitiveContains("CANNOT_DEMOTE_LAST_ADMIN") {
                throw APIError(message: "Promote another administrator before removing the final admin.")
            }
            if error.message.localizedCaseInsensitiveContains("CANNOT_DEMOTE_SELF") {
                throw APIError(message: "Another administrator must remove your owner access.")
            }
            throw APIError(message: error.message, statusCode: error.statusCode)
        }
    }

    func adminArchiveMemberNote(session auth: AuthSession, noteID: UUID, archived: Bool) async throws {
        let _: EmptyResponse = try await rpc(
            path: "admin_set_member_note_archived",
            body: AdminNoteArchiveRequest(p_note_id: noteID, p_archived: archived), auth: auth
        )
    }

    func adminPlatformSettings(session auth: AuthSession) async throws -> AdminPlatformSettings? {
        let settings: [AdminPlatformSettings] = try await restRequest(
            path: "/rest/v1/admin_settings",
            queryItems: [
                URLQueryItem(name: "select", value: "id,target_launch_date,countdown_enabled,bookings_enabled,payments_enabled,prices_coming_soon,fitbox_enabled,fitbox_booking_url,announcement_banner_text,announcement_banner_enabled,updated_at"),
                URLQueryItem(name: "limit", value: "2")
            ],
            auth: auth
        )
        if settings.count > 1 {
            throw APIError(message: "Platform settings integrity check failed. Checkout remains paused until the duplicate settings are repaired.")
        }
        return settings.first
    }

    func adminPTRequests(session auth: AuthSession) async throws -> [AdminPTRequest] {
        let pageSize = 500
        var offset = 0
        var requests: [AdminPTRequest] = []
        while true {
            let page: [AdminPTRequest] = try await restRequest(
                path: "/rest/v1/private_session_requests",
                queryItems: [
                    URLQueryItem(name: "select", value: "id,full_name,email,phone,requested_session_type,preferred_day,preferred_time,training_goal,experience_level,notes,admin_notes,status,created_at"),
                    URLQueryItem(name: "order", value: "created_at.desc,id.desc"),
                    URLQueryItem(name: "limit", value: String(pageSize)),
                    URLQueryItem(name: "offset", value: String(offset))
                ],
                auth: auth
            )
            requests.append(contentsOf: page)
            if page.count < pageSize { return requests }
            offset += pageSize
        }
    }

    func adminLeads(session auth: AuthSession, pipeline: AdminLeadPipeline) async throws -> [AdminLead] {
        let pageSize = 500
        var offset = 0
        var leads: [AdminLead] = []
        while true {
            let page: [AdminLead] = try await restRequest(
                path: "/rest/v1/\(pipeline.rawValue)",
                queryItems: [
                    URLQueryItem(name: "select", value: adminLeadSelect(for: pipeline)),
                    URLQueryItem(name: "order", value: "created_at.desc,id.desc"),
                    URLQueryItem(name: "limit", value: String(pageSize)),
                    URLQueryItem(name: "offset", value: String(offset))
                ],
                auth: auth
            )
            leads.append(contentsOf: page)
            if page.count < pageSize { return leads }
            offset += pageSize
        }
    }

    func adminLeadActionCounts(session auth: AuthSession) async throws -> AdminLeadActionCounts {
        let overdueCutoff = Date().addingTimeInterval(-86_400)
        async let memberLeads = adminLeadCount(session: auth, pipeline: .members, status: "new")
        async let trainerApplicants = adminLeadCount(session: auth, pipeline: .trainers, status: "new")
        async let partnerEnquiries = adminLeadCount(session: auth, pipeline: .partners, status: "new")
        async let overdueMemberLeads = adminLeadCount(
            session: auth,
            pipeline: .members,
            status: "new",
            createdBefore: overdueCutoff
        )
        async let overdueTrainerApplicants = adminLeadCount(
            session: auth,
            pipeline: .trainers,
            status: "new",
            createdBefore: overdueCutoff
        )
        async let overduePartnerEnquiries = adminLeadCount(
            session: auth,
            pipeline: .partners,
            status: "new",
            createdBefore: overdueCutoff
        )
        let counts = try await (
            memberLeads,
            trainerApplicants,
            partnerEnquiries,
            overdueMemberLeads,
            overdueTrainerApplicants,
            overduePartnerEnquiries
        )
        return AdminLeadActionCounts(
            memberLeads: counts.0,
            trainerApplicants: counts.1,
            partnerEnquiries: counts.2,
            overdueMemberLeads: counts.3,
            overdueTrainerApplicants: counts.4,
            overduePartnerEnquiries: counts.5
        )
    }

    private func adminLeadCount(
        session auth: AuthSession,
        pipeline: AdminLeadPipeline,
        status: String,
        createdBefore: Date? = nil
    ) async throws -> Int {
        var queryItems = [
            URLQueryItem(name: "select", value: "id"),
            URLQueryItem(name: "status", value: "eq.\(status)")
        ]
        if let createdBefore {
            queryItems.append(
                URLQueryItem(
                    name: "created_at",
                    value: "lt.\(ISO8601DateFormatter.standard.string(from: createdBefore))"
                )
            )
        }
        return try await restCount(
            path: "/rest/v1/\(pipeline.rawValue)",
            queryItems: queryItems,
            auth: auth
        )
    }

    private func adminLeadSelect(for pipeline: AdminLeadPipeline) -> String {
        let common = "id,full_name,email,phone,status,admin_notes,created_at,utm_source,utm_medium,utm_campaign"
        switch pipeline {
        case .members:
            return common + ",suburb_town,current_training_level,main_training_goals,preferred_training_times"
        case .trainers:
            return common + ",qualifications,years_experience,functional_training_experience,specialties,short_intro"
        case .partners:
            return common + ",profession,business_name,services_offered,short_intro,website_social_link"
        }
    }

    func adminCampaignAttribution(session auth: AuthSession) async throws -> [AdminCampaignAttributionRow] {
        let pageSize = 500
        var offset = 0
        var rows: [AdminCampaignAttributionRow] = []
        while true {
            let page: [AdminCampaignAttributionRow] = try await restRequest(
                path: "/rest/v1/member_interest",
                queryItems: [
                    URLQueryItem(name: "select", value: "id,utm_source,utm_medium,utm_campaign,source,created_at"),
                    URLQueryItem(name: "order", value: "created_at.desc,id.desc"),
                    URLQueryItem(name: "limit", value: String(pageSize)),
                    URLQueryItem(name: "offset", value: String(offset))
                ],
                auth: auth
            )
            rows.append(contentsOf: page)
            if page.count < pageSize { return rows }
            offset += pageSize
        }
    }

    func adminSiteContent(session auth: AuthSession) async throws -> [AdminSiteContentRow] {
        try await restRequest(
            path: "/rest/v1/site_content",
            queryItems: [
                URLQueryItem(name: "select", value: "key,data,updated_at"),
                URLQueryItem(name: "order", value: "key.asc")
            ],
            auth: auth
        )
    }

    func siteContent() async throws -> [AdminSiteContentRow] {
        try await restRequest(
            path: "/rest/v1/site_content",
            queryItems: [
                URLQueryItem(name: "select", value: "key,data,updated_at"),
                URLQueryItem(name: "order", value: "key.asc")
            ]
        )
    }

    func coaches() async throws -> [AdminCoach] {
        try await restRequest(
            path: "/rest/v1/coaches",
            queryItems: [
                URLQueryItem(name: "select", value: "id,name,role,bio,experience,currently_training_for,photo_url,social_url,category,sort_order,published,updated_at"),
                URLQueryItem(name: "published", value: "eq.true"),
                URLQueryItem(name: "order", value: "sort_order.asc,created_at.asc")
            ]
        )
    }

    func adminSaveSiteContent(
        session auth: AuthSession,
        section: AdminSiteContentSection,
        expectedUpdatedAt: String?,
        draft: AdminSiteContentData
    ) async throws -> AdminSiteContentRow {
        let normalized = try draft.normalized(for: section)
        var queryItems: [URLQueryItem] = []
        if let expectedUpdatedAt {
            queryItems = [
                URLQueryItem(name: "key", value: "eq.\(section.rawValue)"),
                URLQueryItem(name: "updated_at", value: "eq.\(expectedUpdatedAt)")
            ]
        }
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/rest/v1/site_content", queryItems: queryItems)
        request.httpMethod = expectedUpdatedAt == nil ? "POST" : "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = expectedUpdatedAt == nil
            ? try JSONEncoder().encode(AdminSiteContentInsertPayload(key: section.rawValue, data: normalized))
            : try JSONEncoder().encode(AdminSiteContentUpdatePayload(data: normalized))
        do {
            let rows: [AdminSiteContentRow] = try await decode(request)
            guard let saved = rows.first, rows.count == 1, saved.key == section.rawValue else {
                throw APIError(message: "Site content changed elsewhere. Refresh and review the latest version.")
            }
            return saved
        } catch let error as APIError where error.statusCode == 409 {
            throw APIError(message: "Site content changed since you opened it. Refresh and review the latest version.")
        }
    }

    func adminUploadSiteImage(
        session auth: AuthSession,
        data: Data,
        mimeType: String,
        fileExtension: String
    ) async throws -> String {
        guard !data.isEmpty, data.count <= 5 * 1_024 * 1_024 else {
            throw APIError(message: "Image must be under 5 MB.")
        }
        guard mimeType.lowercased().hasPrefix("image/") else {
            throw APIError(message: "Please choose an image file.")
        }
        let safeExtension = fileExtension.lowercased().filter { $0.isLetter || $0.isNumber }
        guard !safeExtension.isEmpty else { throw APIError(message: "The selected image type is not supported.") }
        let objectPath = "hero/\(Int(Date().timeIntervalSince1970 * 1_000))-\(UUID().uuidString.prefix(8)).\(safeExtension)"
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/storage/v1/object/site-images/\(objectPath)"
        )
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue("31536000", forHTTPHeaderField: "cache-control")
        request.setValue("false", forHTTPHeaderField: "x-upsert")
        request.httpBody = data
        try await perform(request)

        var publicURL = AppConfig.supabaseURL
        for component in ["storage", "v1", "object", "public", "site-images", "hero"] {
            publicURL.appendPathComponent(component)
        }
        publicURL.appendPathComponent(objectPath.split(separator: "/").last.map(String.init) ?? objectPath)
        return publicURL.absoluteString
    }

    func adminUpdateLead(
        session auth: AuthSession,
        pipeline: AdminLeadPipeline,
        leadID: AdminLeadIdentifier,
        status: String,
        notes: String
    ) async throws {
        try validateLeadMutation(pipeline: pipeline, status: status, ids: [leadID])
        guard notes.count <= 5_000 else { throw APIError(message: "Admin notes must be 5,000 characters or fewer.") }
        let updated: Int = try await rpc(
            path: "admin_update_lead",
            body: AdminLeadUpdateRequest(
                p_lead_type: pipeline.rawValue,
                p_lead_id: leadID.value,
                p_status: status,
                p_admin_notes: notes.trimmingCharacters(in: .whitespacesAndNewlines)
            ),
            auth: auth
        )
        guard updated == 1 else { throw APIError(message: "Lead update was not acknowledged. Refresh and try again.") }
    }

    func adminUpdateLeadStatuses(
        session auth: AuthSession,
        pipeline: AdminLeadPipeline,
        leadIDs: [AdminLeadIdentifier],
        status: String
    ) async throws {
        try validateLeadMutation(pipeline: pipeline, status: status, ids: leadIDs)
        let uniqueIDs = Array(Set(leadIDs)).map(\.value).sorted()
        let updated: Int = try await rpc(
            path: "admin_update_lead_statuses",
            body: AdminLeadBulkUpdateRequest(
                p_lead_type: pipeline.rawValue,
                p_lead_ids: uniqueIDs,
                p_status: status
            ),
            auth: auth
        )
        guard updated == uniqueIDs.count else {
            throw APIError(message: "The complete lead selection was not updated. Refresh and review the pipeline.")
        }
    }

    private func validateLeadMutation(
        pipeline: AdminLeadPipeline,
        status: String,
        ids: [AdminLeadIdentifier]
    ) throws {
        guard pipeline.statuses.contains(status) else { throw APIError(message: "Choose a valid \(pipeline.shortLabel.lowercased()) lead status.") }
        guard !ids.isEmpty, ids.count <= 100 else { throw APIError(message: "Select between 1 and 100 leads.") }
        guard ids.allSatisfy({ !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.value.count <= 128 }) else {
            throw APIError(message: "One or more lead records has an invalid identifier.")
        }
    }

    func adminBookingRequests(session auth: AuthSession) async throws -> [AdminBookingRequest] {
        async let legacyRequest = adminLegacyBookingRequests(session: auth)
        async let memberRequest = adminMemberBookingRequests(session: auth)
        let (legacyRows, memberRows) = try await (legacyRequest, memberRequest)

        let memberIDs = Array(Set(memberRows.map(\.user_id)))
        var profiles: [AdminBookingProfile] = []
        for start in stride(from: 0, to: memberIDs.count, by: 100) {
            let end = min(start + 100, memberIDs.count)
            let ids = memberIDs[start..<end].map(\.uuidString).joined(separator: ",")
            let page: [AdminBookingProfile] = try await restRequest(
                path: "/rest/v1/profiles",
                queryItems: [
                    URLQueryItem(name: "select", value: "id,full_name,email,phone"),
                    URLQueryItem(name: "id", value: "in.(\(ids))")
                ],
                auth: auth
            )
            profiles.append(contentsOf: page)
        }
        let profileByID = Dictionary(uniqueKeysWithValues: profiles.map { ($0.id, $0) })

        let legacy = legacyRows.map { row in
            AdminBookingRequest(
                source: .enquiry,
                recordID: row.id.value,
                memberBookingID: nil,
                fullName: row.full_name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    ?? row.email?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    ?? "Booking enquiry",
                email: row.email,
                phone: row.phone,
                status: row.status,
                adminNotes: row.admin_notes,
                createdAt: row.created_at,
                creditBatchID: nil,
                session: row.class_sessions
            )
        }
        let members = memberRows.map { row in
            let profile = profileByID[row.user_id]
            return AdminBookingRequest(
                source: .member,
                recordID: row.id.uuidString,
                memberBookingID: row.id,
                fullName: profile?.full_name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    ?? profile?.email?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    ?? "XERT member",
                email: profile?.email,
                phone: profile?.phone,
                status: row.status,
                adminNotes: nil,
                createdAt: row.created_at,
                creditBatchID: row.credit_batch_id,
                session: row.class_sessions
            )
        }
        return (legacy + members).sorted { $0.createdAt > $1.createdAt }
    }

    func adminUpdateBookingRequestStatus(
        session auth: AuthSession,
        booking: AdminBookingRequest,
        status: String,
        allowOverbook: Bool = false
    ) async throws -> String? {
        guard booking.allowedNextStatuses.contains(status) else {
            throw APIError(message: "This booking cannot move from \(booking.status) to \(status). Refresh and review it.")
        }
        if booking.source == .member {
            guard let bookingID = booking.memberBookingID else { throw APIError(message: "The member booking ID is invalid.") }
            let outcome = try await adminSetBookingStatus(session: auth, bookingID: bookingID, status: status)
            return outcome.warning
        } else {
            let _: UUID? = try await rpc(
                path: "admin_update_request",
                body: AdminRequestUpdate(
                    p_request_type: "class_booking",
                    p_request_id: booking.recordID,
                    p_status: status,
                    p_admin_notes: nil,
                    p_update_admin_notes: false,
                    p_allow_overbook: allowOverbook
                ),
                auth: auth
            )
            return nil
        }
    }

    func adminUpdateLegacyBookingNotes(
        session auth: AuthSession,
        booking: AdminBookingRequest,
        notes: String
    ) async throws {
        guard booking.source == .enquiry else { throw APIError(message: "Staff notes apply only to enquiry-form bookings.") }
        guard notes.count <= 5_000 else { throw APIError(message: "Admin notes must be 5,000 characters or fewer.") }
        let _: UUID? = try await rpc(
            path: "admin_update_request",
            body: AdminRequestUpdate(
                p_request_type: "class_booking",
                p_request_id: booking.recordID,
                p_status: nil,
                p_admin_notes: notes.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                p_update_admin_notes: true
            ),
            auth: auth
        )
    }

    private func adminLegacyBookingRequests(session auth: AuthSession) async throws -> [AdminLegacyBookingRequest] {
        try await adminBookingPages(
            path: "/rest/v1/class_bookings",
            select: "id,full_name,email,phone,status,admin_notes,created_at,class_sessions(title,start_time,coach_name,location_zone)",
            auth: auth
        )
    }

    private func adminMemberBookingRequests(session auth: AuthSession) async throws -> [AdminMemberBookingRequest] {
        try await adminBookingPages(
            path: "/rest/v1/session_bookings",
            select: "id,user_id,status,created_at,credit_batch_id,class_sessions(title,start_time,coach_name,location_zone)",
            auth: auth
        )
    }

    private func adminBookingPages<T: Decodable>(path: String, select: String, auth: AuthSession) async throws -> [T] {
        let pageSize = 500
        var offset = 0
        var rows: [T] = []
        while true {
            let page: [T] = try await restRequest(
                path: path,
                queryItems: [
                    URLQueryItem(name: "select", value: select),
                    URLQueryItem(name: "order", value: "created_at.desc,id.desc"),
                    URLQueryItem(name: "limit", value: String(pageSize)),
                    URLQueryItem(name: "offset", value: String(offset))
                ],
                auth: auth
            )
            rows.append(contentsOf: page)
            if page.count < pageSize { return rows }
            offset += pageSize
        }
    }

    func adminAnnouncements(session auth: AuthSession) async throws -> [AdminAnnouncement] {
        try await restRequest(
            path: "/rest/v1/member_announcements",
            queryItems: [
                URLQueryItem(name: "select", value: "id,title,body,tone,audience,cta_label,cta_url,published_at,first_published_at,expires_at,archived_at,created_at,updated_at"),
                URLQueryItem(name: "audience", value: "eq.all"),
                URLQueryItem(name: "order", value: "created_at.desc"),
                URLQueryItem(name: "limit", value: "100")
            ],
            auth: auth
        )
    }

    func adminAnnouncement(session auth: AuthSession, id: UUID) async throws -> AdminAnnouncement {
        let rows: [AdminAnnouncement] = try await restRequest(
            path: "/rest/v1/member_announcements",
            queryItems: [
                URLQueryItem(name: "select", value: "id,title,body,tone,audience,cta_label,cta_url,published_at,first_published_at,expires_at,archived_at,created_at,updated_at"),
                URLQueryItem(name: "audience", value: "eq.all"),
                URLQueryItem(name: "id", value: "eq.\(id.uuidString)"),
                URLQueryItem(name: "limit", value: "1")
            ],
            auth: auth
        )
        guard rows.count == 1, rows[0].id == id else {
            throw APIError(message: "This member notice is no longer available to your administrator account.")
        }
        return rows[0]
    }

    func adminAnnouncementReceiptMetrics(
        session auth: AuthSession
    ) async throws -> [AdminAnnouncementReceiptMetrics] {
        try await rpc(
            path: "admin_announcement_metrics",
            body: EmptyBody(),
            auth: auth
        )
    }

    func adminAnnouncementPushMetrics(
        session auth: AuthSession
    ) async throws -> [AdminAnnouncementPushMetrics] {
        try await rpc(
            path: "admin_announcement_push_metrics",
            body: EmptyBody(),
            auth: auth
        )
    }

    func adminSaveAnnouncement(
        session auth: AuthSession,
        announcement: AdminAnnouncement?,
        draft: AdminAnnouncementDraft
    ) async throws -> AdminAnnouncement {
        let payload = try adminAnnouncementPayload(draft, publishing: false)
        var request: URLRequest
        if let announcement {
            guard announcement.archived_at == nil else {
                throw APIError(message: "Restore this notice before editing it.")
            }
            request = try self.request(
                baseURL: AppConfig.supabaseURL,
                path: "/rest/v1/member_announcements",
                queryItems: [
                    URLQueryItem(name: "id", value: "eq.\(announcement.id.uuidString)"),
                    URLQueryItem(name: "updated_at", value: "eq.\(announcement.updated_at)")
                ]
            )
            request.httpMethod = "PATCH"
            request.httpBody = try JSONEncoder().encode(payload)
        } else {
            guard let userID = auth.user?.id else {
                throw APIError(message: "Your admin session has expired. Sign in again.")
            }
            request = try self.request(
                baseURL: AppConfig.supabaseURL,
                path: "/rest/v1/member_announcements"
            )
            request.httpMethod = "POST"
            request.httpBody = try JSONEncoder().encode(
                AdminAnnouncementCreatePayload(
                    announcement: payload,
                    created_by: userID
                )
            )
        }
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        let rows: [AdminAnnouncement] = try await decode(request)
        guard rows.count == 1 else {
            throw APIError(message: announcement == nil
                ? "The notice draft could not be created."
                : "This notice changed elsewhere. Refresh and review the latest version.")
        }
        return rows[0]
    }

    func adminUnpublishAnnouncement(
        session auth: AuthSession,
        announcement: AdminAnnouncement
    ) async throws -> AdminAnnouncement {
        guard announcement.archived_at == nil else {
            throw APIError(message: "Restore this notice before changing its visibility.")
        }
        var request = try self.request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/member_announcements",
            queryItems: [
                URLQueryItem(name: "id", value: "eq.\(announcement.id.uuidString)"),
                URLQueryItem(name: "updated_at", value: "eq.\(announcement.updated_at)")
            ]
        )
        request.httpMethod = "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(AdminAnnouncementUnpublishPayload())
        let rows: [AdminAnnouncement] = try await decode(request)
        guard rows.count == 1 else {
            throw APIError(message: "This notice changed elsewhere. Refresh before unpublishing it.")
        }
        return rows[0]
    }

    func adminSetAnnouncementArchived(
        session auth: AuthSession,
        announcement: AdminAnnouncement,
        archived: Bool
    ) async throws {
        let _: EmptyResponse = try await rpc(
            path: "admin_archive_member_announcement",
            body: AdminAnnouncementArchiveRequest(
                p_announcement_id: announcement.id,
                p_archived: archived,
                p_expected_updated_at: announcement.updated_at
            ),
            auth: auth
        )
    }

    func adminDeleteAnnouncement(
        session auth: AuthSession,
        announcement: AdminAnnouncement
    ) async throws {
        guard !announcement.wasPublished else {
            throw APIError(message: "Published notices must be archived so delivery history remains intact.")
        }
        var request = try self.request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/member_announcements",
            queryItems: [
                URLQueryItem(name: "id", value: "eq.\(announcement.id.uuidString)"),
                URLQueryItem(name: "updated_at", value: "eq.\(announcement.updated_at)")
            ]
        )
        request.httpMethod = "DELETE"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        let rows: [AdminMutationID] = try await decode(request)
        guard rows.count == 1 else {
            throw APIError(message: "This draft changed elsewhere. Refresh before deleting it.")
        }
    }

    func adminSchemaCapabilities(session auth: AuthSession) async throws -> [AdminSchemaCapability] {
        try await restRequest(
            path: "/rest/v1/xert_schema_capabilities",
            queryItems: [
                URLQueryItem(name: "select", value: "capability,installed_at"),
                URLQueryItem(name: "order", value: "capability.asc")
            ],
            auth: auth
        )
    }

    func adminCommerceHealth(session auth: AuthSession) async throws -> AdminCommerceHealth {
        try await vercelGet(path: "/api/admin-commerce-health", auth: auth)
    }

    func adminFitboxLeadState(
        session auth: AuthSession,
        leadID: AdminLeadIdentifier
    ) async throws -> AdminFitboxLeadState {
        try await vercelGet(
            path: "/api/admin-fitbox-integration",
            queryItems: [URLQueryItem(name: "lead_id", value: leadID.value)],
            auth: auth
        )
    }

    func adminFitboxBridgeHealth(session auth: AuthSession) async throws -> AdminFitboxBridgeHealth {
        try await vercelGet(
            path: "/api/admin-fitbox-integration",
            queryItems: [URLQueryItem(name: "health", value: "1")],
            auth: auth
        )
    }

    func adminSendLeadToFitbox(
        session auth: AuthSession,
        leadID: AdminLeadIdentifier
    ) async throws -> AdminFitboxMutationResponse {
        try await vercelRequest(
            path: "/api/admin-fitbox-integration",
            body: AdminFitboxProspectRequest(action: "register_prospect", lead_id: leadID.value),
            auth: auth
        )
    }

    func adminRefreshFitboxUser(
        session auth: AuthSession,
        leadID: AdminLeadIdentifier
    ) async throws -> AdminFitboxMutationResponse {
        try await vercelRequest(
            path: "/api/admin-fitbox-integration",
            body: AdminFitboxProspectRequest(action: "refresh_user", lead_id: leadID.value),
            auth: auth
        )
    }

    func adminFitboxOverview(session auth: AuthSession) async throws -> AdminFitboxOverview {
        try await vercelGet(
            path: "/api/admin-fitbox-integration",
            queryItems: [URLQueryItem(name: "overview", value: "1")],
            auth: auth
        )
    }

    func adminFitboxUsers(session auth: AuthSession) async throws -> [AdminFitboxUser] {
        try await restRequest(
            path: "/rest/v1/fitbox_users",
            queryItems: [
                URLQueryItem(name: "select", value: "id,fitbox_user_id,first_name,last_name,email,phone,city,status,role,synced_at"),
                URLQueryItem(name: "order", value: "synced_at.desc,id.desc"),
                URLQueryItem(name: "limit", value: "300")
            ],
            auth: auth
        )
    }

    func adminFitboxSubscriptions(session auth: AuthSession) async throws -> [AdminFitboxSubscription] {
        try await restRequest(
            path: "/rest/v1/fitbox_subscriptions",
            queryItems: [
                URLQueryItem(name: "select", value: "id,fitbox_subscription_id,fitbox_user_id,email,product_name,status,price_in_cents,start_date,expiration_date,sessions_count,synced_at"),
                URLQueryItem(name: "order", value: "synced_at.desc,id.desc"),
                URLQueryItem(name: "limit", value: "300")
            ],
            auth: auth
        )
    }

    func adminFitboxUpcomingAttendance(session auth: AuthSession) async throws -> [AdminFitboxAttendance] {
        try await restRequest(
            path: "/rest/v1/fitbox_attendance",
            queryItems: [
                URLQueryItem(name: "select", value: "id,fitbox_attendance_id,class_name,fitbox_user_id,session_start_time,status,feed,synced_at"),
                URLQueryItem(name: "session_start_time", value: "gte.\(ISO8601DateFormatter.standard.string(from: Date()))"),
                URLQueryItem(name: "order", value: "session_start_time.asc"),
                URLQueryItem(name: "limit", value: "200")
            ],
            auth: auth
        )
    }

    func adminRunFitboxSync(session auth: AuthSession, feed: String) async throws -> AdminFitboxSyncResponse {
        try await vercelRequest(
            path: "/api/admin-fitbox-integration",
            body: AdminFitboxSyncRequest(action: "sync_fitbox", feed: feed),
            auth: auth
        )
    }

    func adminLookupFitboxUser(session auth: AuthSession, email: String) async throws -> AdminFitboxLookupResponse {
        try await vercelRequest(
            path: "/api/admin-fitbox-integration",
            body: AdminFitboxLookupRequest(action: "lookup_fitbox", email: email, fitbox_user_id: ""),
            auth: auth
        )
    }

    func adminResolveStripeReview(
        session auth: AuthSession,
        eventID: String,
        errorCode: String
    ) async throws -> AdminStripeReviewResolutionResponse {
        let response: AdminStripeReviewResolutionResponse = try await vercelRequest(
            path: "/api/admin-commerce-health",
            body: AdminStripeReviewResolutionRequest(
                action: "resolve_stripe_review",
                confirmation: "MARK HANDLED",
                event_id: eventID,
                error_code: errorCode
            ),
            auth: auth
        )
        guard response.event_id == eventID, response.status == "ignored" else {
            throw APIError(message: "XERT could not verify the handled Stripe incident receipt.")
        }
        return response
    }

    func adminRetryStripeEvent(session auth: AuthSession, eventID: String) async throws -> AdminStripeRetryResponse {
        let response: AdminStripeRetryResponse = try await vercelRequest(
            path: "/api/admin-commerce-health",
            body: AdminStripeRetryRequest(
                action: "retry_stripe_event",
                confirmation: "RETRY EVENT",
                event_id: eventID
            ),
            auth: auth
        )
        guard response.event_id == eventID,
              ["processed", "ignored", "failed"].contains(response.status) else {
            throw APIError(message: "XERT could not verify the Stripe retry receipt.")
        }
        return response
    }

    func adminPushHealth(session auth: AuthSession) async throws -> AdminPushHealth {
        try await vercelGet(path: "/api/admin-push-health", auth: auth)
    }

    func adminSendOwnerPushSmokeTest(session auth: AuthSession) async throws -> AdminOwnerPushSmokeTestResult {
        try await vercelRequest(
            path: "/api/admin-publish-announcement",
            body: AdminOwnerPushSmokeTestRequest(action: "test_owner_push"),
            auth: auth
        )
    }

    func adminAudit(session auth: AuthSession) async throws -> AdminAuditSnapshot {
        async let roles: Result<[AdminRoleAuditRow], Error> = adminAuditResult(
            table: "admin_role_changes",
            select: "id,target_user_id,changed_by,previous_role,new_role,created_at",
            auth: auth
        )
        async let credits: Result<[AdminCreditAuditRow], Error> = adminAuditResult(
            table: "admin_credit_grants",
            select: "id,user_id,granted_by,sessions,note,created_at",
            auth: auth
        )
        async let requests: Result<[AdminRequestAuditRow], Error> = adminAuditResult(
            table: "admin_request_status_changes",
            select: "id,request_id,request_type,changed_by,previous_status,new_status,subject_label,subject_email,created_at",
            auth: auth
        )
        async let notices: Result<[AdminNoticeAuditRow], Error> = adminAuditResult(
            table: "member_announcement_admin_events",
            select: "id,announcement_id,announcement_title,action,actor_id,created_at",
            auth: auth
        )
        async let leads: Result<[AdminLeadAuditRow], Error> = adminAuditResult(
            table: "admin_lead_changes",
            select: "id,lead_id,lead_type,changed_by,previous_status,new_status,subject_label,subject_email,created_at",
            auth: auth
        )
        async let schedules: Result<[AdminResourceAuditRow], Error> = adminAuditResult(
            table: "admin_schedule_changes",
            select: "id,resource_id,resource_type,action,changed_by,subject_label,created_at",
            auth: auth
        )
        async let content: Result<[AdminResourceAuditRow], Error> = adminAuditResult(
            table: "admin_content_changes",
            select: "id,resource_id,resource_type,action,changed_by,subject_label,created_at",
            auth: auth
        )
        async let bookings: Result<[AdminBookingAuditRow], Error> = adminAuditResult(
            table: "session_booking_changes",
            select: "id,booking_id,member_id,changed_by,action,class_label,created_at",
            auth: auth
        )
        async let reconciliations: Result<[AdminOrderReconciliationAuditRow], Error> = adminAuditResult(
            table: "orders",
            select: "id,status,amount_cents,currency,reconciled_at,reconciled_by",
            order: "reconciled_at.desc,id.desc",
            filters: [URLQueryItem(name: "reconciled_at", value: "not.is.null")],
            auth: auth
        )
        async let refunds: Result<[AdminRefundAuditRow], Error> = adminAuditResult(
            table: "stripe_refunds",
            select: "refund_id,stripe_event_id,order_id,amount_cents,currency,credits_revoked,credits_consumed,bookings_cancelled,refunded_at",
            order: "refunded_at.desc,refund_id.desc",
            auth: auth
        )

        let results = await (
            roles, credits, requests, notices, leads, schedules, content, bookings,
            reconciliations, refunds
        )
        var unavailableSources: [String] = []
        let roleRows = resolvedAuditRows(results.0, source: "Role changes", unavailable: &unavailableSources)
        let creditRows = resolvedAuditRows(results.1, source: "Credit grants", unavailable: &unavailableSources)
        let requestRows = resolvedAuditRows(results.2, source: "Request changes", unavailable: &unavailableSources)
        let noticeRows = resolvedAuditRows(results.3, source: "Announcement changes", unavailable: &unavailableSources)
        let leadRows = resolvedAuditRows(results.4, source: "Lead changes", unavailable: &unavailableSources)
        let scheduleRows = resolvedAuditRows(results.5, source: "Schedule changes", unavailable: &unavailableSources)
        let contentRows = resolvedAuditRows(results.6, source: "Content changes", unavailable: &unavailableSources)
        let bookingRows = resolvedAuditRows(results.7, source: "Booking changes", unavailable: &unavailableSources)
        let reconciliationRows = resolvedAuditRows(
            results.8,
            source: "Order reconciliation",
            unavailable: &unavailableSources
        )
        let refundRows = resolvedAuditRows(results.9, source: "Refunds", unavailable: &unavailableSources)
        guard unavailableSources.count < 10 else {
            throw APIError(message: "Every protected Activity log source is unavailable.")
        }
        let all = [
            roleRows.map { $0.entry }, creditRows.map { $0.entry }, requestRows.map { $0.entry },
            noticeRows.map { $0.entry }, leadRows.map { $0.entry },
            scheduleRows.map { $0.entry(category: "Schedule") },
            contentRows.map { $0.entry(category: "Content") }, bookingRows.map { $0.entry },
            reconciliationRows.map { $0.entry }, refundRows.map { $0.entry }
        ]
        let entries = all
            .flatMap { $0 }
            .sorted { $0.createdAt > $1.createdAt }
            .prefix(300)
            .map { $0 }
        return AdminAuditSnapshot(entries: entries, unavailableSources: unavailableSources)
    }

    func adminProducts(session auth: AuthSession) async throws -> [AdminProduct] {
        try await restRequest(
            path: "/rest/v1/products",
            queryItems: [
                URLQueryItem(name: "select", value: "id,slug,name,description,price_cents,currency,sessions_count,validity_days,stripe_price_id,featured,active,sort_order,updated_at"),
                URLQueryItem(name: "order", value: "sort_order.asc,created_at.asc")
            ],
            auth: auth
        )
    }

    func adminCreateProduct(session auth: AuthSession, draft: AdminProductDraft) async throws -> AdminProduct {
        let payload = try adminProductCreatePayload(draft)
        do {
            let result: AdminProductRPCResult = try await rpc(
                path: "admin_create_product",
                body: AdminProductCreateRequest(
                    p_slug: draft.slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                    p_product: payload
                ),
                auth: auth
            )
            return result.product
        } catch let error as APIError where error.message.localizedCaseInsensitiveContains("products_slug_key")
            || error.message.localizedCaseInsensitiveContains("duplicate key")
            || error.message.localizedCaseInsensitiveContains("PRODUCT_SLUG_TAKEN") {
            throw APIError(message: "That permanent pack ID is already in use. Choose another one.")
        } catch let error as APIError {
            throw friendlyProductError(error)
        }
    }

    func adminUpdateProduct(session auth: AuthSession, product: AdminProduct, draft: AdminProductDraft) async throws -> AdminProduct {
        let payload = try adminProductPayload(draft, existingProduct: product)

        do {
            if draft.active {
                return try await vercelRequest(
                    path: "/api/admin-commerce-health",
                    body: AdminProductActivationRequest(
                        action: "activate_product",
                        product_id: product.id,
                        product: payload,
                        expected_updated_at: product.updated_at
                    ),
                    auth: auth
                )
            }
            let result: AdminProductRPCResult = try await rpc(
                path: "admin_update_product",
                body: AdminProductUpdateRequest(
                    p_product_id: product.id,
                    p_product: payload,
                    p_expected_updated_at: product.updated_at
                ),
                auth: auth
            )
            return result.product
        } catch let error as APIError {
            throw friendlyProductError(error)
        }
    }

    private func friendlyProductError(_ error: APIError) -> APIError {
        if error.message.localizedCaseInsensitiveContains("PRODUCT_STALE") {
            return APIError(message: "This pack changed since you opened it. Close it, refresh pricing and review the latest version.")
        }
        if error.message.localizedCaseInsensitiveContains("STRIPE_PRICE_REFRESH_REQUIRED") {
            return APIError(message: "Clear or replace the Stripe Price ID before changing price, currency, sessions or validity.")
        }
        if error.message.localizedCaseInsensitiveContains("INVALID_PRODUCT_PAYLOAD") {
            return APIError(message: "One or more pack details are invalid. Review the price, credits, validity and sale state.")
        }
        if error.message.localizedCaseInsensitiveContains("ACTIVE_PRODUCT_REQUIRES_STRIPE_PRICE") {
            return APIError(message: "Add a Stripe Price ID before making this pack active and purchasable.")
        }
        if error.message.localizedCaseInsensitiveContains("PRODUCT_ACTIVATION_VERIFICATION_REQUIRED") {
            return APIError(message: "Active packs must be verified against Stripe before they can be saved.")
        }
        if error.message.localizedCaseInsensitiveContains("Stripe price does not match")
            || error.message.localizedCaseInsensitiveContains("PRODUCT_ACTIVATION_SAVE_FAILED")
            || error.message.localizedCaseInsensitiveContains("INVALID_PRODUCT_ACTIVATION") {
            return APIError(message: "Stripe could not verify this pack's price, currency, credits and validity. Check the Price ID and its metadata, then try again.")
        }
        if error.message.localizedCaseInsensitiveContains("PRODUCT_NOT_FOUND") {
            return APIError(message: "This session pack is no longer available. Refresh pricing and try again.")
        }
        return APIError(message: error.message, statusCode: error.statusCode)
    }

    private func adminProductPayload(
        _ draft: AdminProductDraft,
        existingProduct: AdminProduct?
    ) throws -> AdminProductPayload {
        if let issue = draft.validationMessage(existingProduct: existingProduct) {
            throw APIError(message: issue)
        }
        guard let priceCents = draft.normalizedPriceCents else {
            throw APIError(message: "Enter a positive price up to 21,474,836.47 with no more than two decimal places.")
        }
        return AdminProductPayload(
            name: draft.name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: draft.description.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            price_cents: priceCents,
            currency: draft.currency.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            sessions_count: draft.sessions,
            validity_days: draft.validityDays,
            stripe_price_id: draft.stripePriceID.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            featured: draft.featured,
            active: draft.active,
            sort_order: draft.sortOrder
        )
    }

    private func adminProductCreatePayload(_ draft: AdminProductDraft) throws -> AdminProductCreatePayload {
        let payload = try adminProductPayload(draft, existingProduct: nil)
        return AdminProductCreatePayload(
            name: payload.name,
            description: payload.description,
            price_cents: payload.price_cents,
            currency: payload.currency,
            sessions_count: payload.sessions_count,
            validity_days: payload.validity_days,
            stripe_price_id: nil,
            featured: payload.featured,
            active: false,
            sort_order: payload.sort_order
        )
    }

    func adminEvents(session auth: AuthSession) async throws -> [AdminEvent] {
        try await restRequest(
            path: "/rest/v1/events",
            queryItems: [
                URLQueryItem(name: "select", value: "id,name,category,event_date,end_date,location,region,url,published,sort_order,updated_at"),
                URLQueryItem(name: "order", value: "event_date.asc.nullslast,sort_order.asc")
            ],
            auth: auth
        )
    }

    func adminEvent(session auth: AuthSession, id: UUID) async throws -> AdminEvent {
        let rows: [AdminEvent] = try await restRequest(
            path: "/rest/v1/events",
            queryItems: [
                URLQueryItem(name: "select", value: "id,name,category,event_date,end_date,location,region,url,published,sort_order,updated_at"),
                URLQueryItem(name: "id", value: "eq.\(id.uuidString)"),
                URLQueryItem(name: "limit", value: "1")
            ],
            auth: auth
        )
        guard rows.count == 1, rows[0].id == id else {
            throw APIError(message: "This event is no longer available to your administrator account.")
        }
        return rows[0]
    }

    func adminEventGoalReferences(session auth: AuthSession) async throws -> [AdminEventGoalReference] {
        try await restRequest(
            path: "/rest/v1/member_event_goals",
            queryItems: [URLQueryItem(name: "select", value: "event_id")],
            auth: auth
        )
    }

    func adminEventGoalMembers(session auth: AuthSession, eventID: UUID) async throws -> [AdminEventGoalMember] {
        try await rpc(
            path: "admin_event_goal_members",
            body: ["p_event_id": eventID.uuidString],
            auth: auth
        )
    }

    func adminCreateEvent(session auth: AuthSession, draft: AdminEventDraft) async throws -> AdminEvent {
        let payload = try adminEventPayload(draft)
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/rest/v1/events")
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(payload)
        let rows: [AdminEvent] = try await decode(request)
        guard let event = rows.first, rows.count == 1 else {
            throw APIError(message: "The event was not returned after creation. Refresh the calendar before trying again.")
        }
        return event
    }

    func adminSeedEventCalendar(session auth: AuthSession) async throws -> [AdminEvent] {
        let payload = try XertEventCalendar.fallback
            .map { AdminEventDraft(seed: $0) }
            .map { try adminEventPayload($0) }
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/events",
            queryItems: [URLQueryItem(name: "on_conflict", value: "name,event_date")]
        )
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("resolution=ignore-duplicates,return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(payload)
        let inserted: [AdminEvent] = try await decode(request)
        guard inserted.count <= payload.count else {
            throw APIError(message: "The event calendar returned an invalid insertion receipt. Refresh before continuing.")
        }
        return inserted
    }

    func adminUpdateEvent(session auth: AuthSession, event: AdminEvent, draft: AdminEventDraft) async throws -> AdminEvent {
        let payload = try adminEventPayload(draft)
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/events",
            queryItems: [
                URLQueryItem(name: "id", value: "eq.\(event.id.uuidString)"),
                URLQueryItem(name: "updated_at", value: "eq.\(event.updated_at)")
            ]
        )
        request.httpMethod = "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(payload)
        let rows: [AdminEvent] = try await decode(request)
        guard let updated = rows.first, rows.count == 1 else {
            throw APIError(message: "This event changed elsewhere. Refresh the calendar and review the latest version.")
        }
        return updated
    }

    func adminDeleteEvent(session auth: AuthSession, event: AdminEvent) async throws {
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/events",
            queryItems: [
                URLQueryItem(name: "id", value: "eq.\(event.id.uuidString)"),
                URLQueryItem(name: "updated_at", value: "eq.\(event.updated_at)")
            ]
        )
        request.httpMethod = "DELETE"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        let rows: [AdminMutationID] = try await decode(request)
        guard !rows.isEmpty else {
            throw APIError(message: "This event changed elsewhere. Refresh the calendar before deleting it.")
        }
    }

    private func adminEventPayload(_ draft: AdminEventDraft) throws -> AdminEventPayload {
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw APIError(message: "An event name is required.") }
        guard draft.sortOrder >= 0 else { throw APIError(message: "Sort order cannot be negative.") }
        if draft.hasEndDate && !draft.hasStartDate {
            throw APIError(message: "Add a start date before adding an end date.")
        }
        if draft.hasStartDate && draft.hasEndDate && draft.endDate < draft.startDate {
            throw APIError(message: "The end date cannot be before the start date.")
        }
        let link = draft.url.trimmingCharacters(in: .whitespacesAndNewlines)
        if !link.isEmpty {
            guard let url = URL(string: link), let scheme = url.scheme?.lowercased(),
                  ["https", "http"].contains(scheme), url.host != nil else {
                throw APIError(message: "Enter a complete event website beginning with https://.")
            }
        }
        return AdminEventPayload(
            name: name,
            category: draft.category,
            event_date: draft.startDateValue,
            end_date: draft.endDateValue,
            location: draft.location.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            region: draft.region.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            url: link.nilIfEmpty,
            published: draft.published,
            sort_order: draft.sortOrder
        )
    }

    func adminCoaches(session auth: AuthSession) async throws -> [AdminCoach] {
        try await restRequest(
            path: "/rest/v1/coaches",
            queryItems: [
                URLQueryItem(name: "select", value: "id,name,role,bio,experience,currently_training_for,photo_url,social_url,category,sort_order,published,updated_at"),
                URLQueryItem(name: "order", value: "sort_order.asc,created_at.asc")
            ],
            auth: auth
        )
    }

    func adminCreateCoach(session auth: AuthSession, draft: AdminCoachDraft) async throws -> AdminCoach {
        let payload = try adminCoachPayload(draft)
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/rest/v1/coaches")
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(payload)
        let rows: [AdminCoach] = try await decode(request)
        guard let coach = rows.first, rows.count == 1 else {
            throw APIError(message: "The team profile was not returned after creation. Refresh the directory before trying again.")
        }
        return coach
    }

    func adminUpdateCoach(session auth: AuthSession, coach: AdminCoach, draft: AdminCoachDraft) async throws -> AdminCoach {
        let payload = try adminCoachPayload(draft)
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/coaches",
            queryItems: [
                URLQueryItem(name: "id", value: "eq.\(coach.id.uuidString)"),
                URLQueryItem(name: "updated_at", value: "eq.\(coach.updated_at)")
            ]
        )
        request.httpMethod = "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(payload)
        let rows: [AdminCoach] = try await decode(request)
        guard let updated = rows.first, rows.count == 1 else {
            throw APIError(message: "This team profile changed elsewhere. Refresh and review the latest version.")
        }
        return updated
    }

    func adminDeleteCoach(session auth: AuthSession, coach: AdminCoach) async throws {
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/coaches",
            queryItems: [
                URLQueryItem(name: "id", value: "eq.\(coach.id.uuidString)"),
                URLQueryItem(name: "updated_at", value: "eq.\(coach.updated_at)")
            ]
        )
        request.httpMethod = "DELETE"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        let rows: [AdminMutationID] = try await decode(request)
        guard !rows.isEmpty else {
            throw APIError(message: "This team profile changed elsewhere. Refresh before deleting it.")
        }
    }

    private func adminCoachPayload(_ draft: AdminCoachDraft) throws -> AdminCoachPayload {
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw APIError(message: "A team member name is required.") }
        guard name.count <= 120 else { throw APIError(message: "Name must be 120 characters or fewer.") }
        guard AdminCoachDraft.categories.contains(draft.category) else {
            throw APIError(message: "Choose a valid team category.")
        }
        guard draft.sortOrder >= 0 else { throw APIError(message: "Sort order cannot be negative.") }
        let photo = try validatedWebLink(draft.photoURL, label: "Photo URL", allowsRelative: true)
        let social = try validatedWebLink(draft.socialURL, label: "Social link")
        return AdminCoachPayload(
            name: name,
            role: draft.role.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            bio: draft.bio.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            experience: draft.experience.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            currently_training_for: draft.currentlyTrainingFor.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            photo_url: photo,
            social_url: social,
            category: draft.category,
            sort_order: draft.sortOrder,
            published: draft.published
        )
    }

    private func validatedWebLink(_ value: String, label: String, allowsRelative: Bool = false) throws -> String? {
        let link = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !link.isEmpty else { return nil }
        if allowsRelative && link.hasPrefix("/") { return link }
        guard let url = URL(string: link), let scheme = url.scheme?.lowercased(),
              ["https", "http"].contains(scheme), url.host != nil else {
            throw APIError(message: "\(label) must be a complete http:// or https:// address.")
        }
        return link
    }

    private func adminAuditRows<T: Decodable>(
        table: String,
        select: String,
        order: String = "created_at.desc,id.desc",
        filters: [URLQueryItem] = [],
        auth: AuthSession
    ) async throws -> [T] {
        try await restRequest(
            path: "/rest/v1/\(table)",
            queryItems: [
                URLQueryItem(name: "select", value: select),
                URLQueryItem(name: "order", value: order),
                URLQueryItem(name: "limit", value: "100")
            ] + filters,
            auth: auth
        )
    }

    func adminPublishAnnouncement(
        session auth: AuthSession,
        title: String,
        body: String,
        tone: String
    ) async throws {
        var draft = AdminAnnouncementDraft()
        draft.title = title
        draft.body = body
        draft.tone = tone
        _ = try await adminPublishAnnouncement(
            session: auth,
            announcement: nil,
            draft: draft
        )
    }

    private func adminAuditResult<T: Decodable>(
        table: String,
        select: String,
        order: String = "created_at.desc,id.desc",
        filters: [URLQueryItem] = [],
        auth: AuthSession
    ) async -> Result<[T], Error> {
        do {
            return .success(try await adminAuditRows(
                table: table,
                select: select,
                order: order,
                filters: filters,
                auth: auth
            ))
        } catch {
            return .failure(error)
        }
    }

    private func resolvedAuditRows<T>(
        _ result: Result<[T], Error>,
        source: String,
        unavailable: inout [String]
    ) -> [T] {
        switch result {
        case .success(let rows):
            return rows
        case .failure:
            unavailable.append(source)
            return []
        }
    }

    func adminPublishAnnouncement(
        session auth: AuthSession,
        announcement: AdminAnnouncement?,
        draft: AdminAnnouncementDraft,
        requestID: UUID = UUID()
    ) async throws -> AdminAnnouncementPublishOutcome {
        if announcement?.archived_at != nil {
            throw APIError(message: "Restore this notice before publishing it.")
        }
        let payload = try adminAnnouncementPayload(draft, publishing: true)
        return try await vercelRequest(
            path: "/api/admin-publish-announcement",
            body: AdminAnnouncementPublishRequest(
                id: announcement?.id,
                request_id: requestID,
                announcement: payload,
                expected_updated_at: announcement?.updated_at
            ),
            auth: auth
        )
    }

    private func adminAnnouncementPayload(
        _ draft: AdminAnnouncementDraft,
        publishing: Bool
    ) throws -> AdminAnnouncementPayload {
        if let message = draft.validationMessage(publishing: publishing) {
            throw APIError(message: message)
        }
        let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = draft.body.trimmingCharacters(in: .whitespacesAndNewlines)
        let ctaLabel = draft.ctaLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        let ctaURL = draft.ctaURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return AdminAnnouncementPayload(
            title: title,
            body: body,
            tone: draft.tone,
            expires_at: draft.expiresAt.map { ISO8601DateFormatter.standard.string(from: $0) },
            cta_label: ctaLabel.isEmpty ? nil : ctaLabel,
            cta_url: ctaURL.isEmpty ? nil : ctaURL
        )
    }

    func adminUpdatePTRequest(
        session auth: AuthSession,
        requestID: UUID,
        status: String,
        adminNotes: String? = nil,
        updateNotes: Bool = false
    ) async throws -> UUID {
        let allowed = ["requested", "approved", "declined", "reschedule_requested", "completed", "cancelled"]
        guard allowed.contains(status) else { throw APIError(message: "Choose a valid PT request status.") }
        if let adminNotes, adminNotes.count > 5_000 {
            throw APIError(message: "Admin notes must be 5,000 characters or fewer.")
        }
        let receipt: UUID? = try await rpc(
            path: "admin_update_request",
            body: AdminRequestUpdate(
                p_request_type: "private_session",
                p_request_id: requestID.uuidString,
                p_status: status,
                p_admin_notes: adminNotes?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                p_update_admin_notes: updateNotes
            ),
            auth: auth
        )
        guard let receipt else {
            throw APIError(message: "No PT request change was confirmed. Refresh and review the latest request.")
        }
        return receipt
    }

    func adminUpdatePlatformSettings(
        session auth: AuthSession,
        settings: AdminPlatformSettings
    ) async throws -> AdminPlatformSettings {
        let banner = settings.announcementText.trimmingCharacters(in: .whitespacesAndNewlines)
        if settings.announcement_banner_enabled && banner.isEmpty {
            throw APIError(message: "Add announcement text before enabling the banner.")
        }
        guard settings.target_launch_date.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
            throw APIError(message: "Enter the launch date as YYYY-MM-DD.")
        }
        if settings.fitbox_enabled {
            guard settings.providerResolution.provider == .fitBox,
                  !settings.providerResolution.isBlocked else {
                throw APIError(message: "Add a secure HTTPS FitBox booking link before selecting FitBox.")
            }
            guard !settings.payments_enabled else {
                throw APIError(message: "XERT session-pack payments must be paused while FitBox is selected.")
            }
        }

        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/admin_settings",
            queryItems: [
                URLQueryItem(name: "id", value: "eq.\(settings.id.uuidString)"),
                URLQueryItem(name: "updated_at", value: "eq.\(settings.updated_at)")
            ]
        )
        request.httpMethod = "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(AdminSettingsUpdate(
            target_launch_date: settings.target_launch_date,
            countdown_enabled: settings.countdown_enabled,
            bookings_enabled: settings.bookings_enabled,
            payments_enabled: settings.payments_enabled,
            prices_coming_soon: settings.prices_coming_soon,
            fitbox_enabled: settings.fitbox_enabled,
            fitbox_booking_url: settings.fitbox_booking_url?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            announcement_banner_text: banner.isEmpty ? nil : banner,
            announcement_banner_enabled: settings.announcement_banner_enabled,
            updated_at: ISO8601DateFormatter.standard.string(from: Date())
        ))
        let rows: [AdminPlatformSettings] = try await decode(request)
        guard let updated = rows.first else {
            throw APIError(message: "Platform settings changed elsewhere. Refresh and review the latest values before saving.")
        }
        return updated
    }

    func adminPauseMemberOperations(
        session auth: AuthSession,
        settings: AdminPlatformSettings
    ) async throws -> AdminPlatformSettings {
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/admin_settings",
            queryItems: [
                URLQueryItem(name: "id", value: "eq.\(settings.id.uuidString)"),
                URLQueryItem(name: "updated_at", value: "eq.\(settings.updated_at)")
            ]
        )
        request.httpMethod = "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(AdminEmergencyPauseUpdate(
            bookings_enabled: false,
            payments_enabled: false,
            updated_at: ISO8601DateFormatter.standard.string(from: Date())
        ))
        let rows: [AdminPlatformSettings] = try await decode(request)
        guard
            rows.count == 1,
            let updated = rows.first,
            updated.id == settings.id,
            !updated.bookings_enabled,
            !updated.payments_enabled
        else {
            throw APIError(message: "Emergency pause could not be confirmed. Refresh Platform Controls and try again.")
        }
        return updated
    }

    func adminActivatePlatformPayments(
        session auth: AuthSession,
        settings: AdminPlatformSettings
    ) async throws -> AdminPlatformSettings {
        guard settings.payments_enabled else {
            throw APIError(message: "Payment activation requires an enabled payment draft.")
        }
        guard !settings.fitbox_enabled else {
            throw APIError(message: "Stripe activation is unavailable while FitBox is the selected booking provider.")
        }
        let banner = settings.announcementText.trimmingCharacters(in: .whitespacesAndNewlines)
        if settings.announcement_banner_enabled && banner.isEmpty {
            throw APIError(message: "Add announcement text before enabling the banner.")
        }
        guard settings.target_launch_date.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
            throw APIError(message: "Enter the launch date as YYYY-MM-DD.")
        }

        return try await vercelRequest(
            path: "/api/admin-commerce-health",
            body: AdminPaymentActivationRequest(
                action: "activate_payments",
                confirmation: "ENABLE PAYMENTS",
                settings_id: settings.id,
                expected_updated_at: settings.updated_at,
                settings: AdminPaymentActivationSettings(
                    target_launch_date: settings.target_launch_date,
                    countdown_enabled: settings.countdown_enabled,
                    bookings_enabled: settings.bookings_enabled,
                    payments_enabled: true,
                    fitbox_enabled: settings.fitbox_enabled,
                    announcement_banner_text: banner.isEmpty ? nil : banner,
                    announcement_banner_enabled: settings.announcement_banner_enabled
                )
            ),
            auth: auth
        )
    }

    func adminPromoteNextWaitlisted(
        session auth: AuthSession,
        classSessionID: UUID,
        expectedBookingID: UUID,
        requestID: UUID
    ) async throws -> AdminWaitlistPromotionOutcome {
        let rows: [AdminWaitlistPromotion] = try await rpc(
            path: "admin_promote_next_waitlisted_with_notice",
            body: AdminWaitlistPromotionRequest(
                p_session_id: classSessionID,
                p_expected_booking_id: expectedBookingID,
                p_request_id: requestID
            ),
            auth: auth
        )
        guard rows.count == 1, let promotion = rows.first,
              promotion.session_id == classSessionID,
              promotion.booking_id == expectedBookingID else {
            throw APIError(message: "The promotion completed without a verifiable member notice receipt. Refresh the waitlist before continuing.")
        }
        do {
            let response: AdminTargetedNoticeResponse = try await vercelRequest(
                path: "/api/admin-publish-announcement",
                body: AdminTargetedNoticeRequest(
                    action: "notify_targeted_announcement",
                    announcement_id: promotion.announcement_id
                ),
                auth: auth
            )
            return AdminWaitlistPromotionOutcome(
                promotion: promotion,
                pushDelivered: (response.push?.delivered ?? 0) > 0,
                warning: response.push?.configured == false
                    ? "The member is confirmed and their private notice is live, but Apple push is not configured."
                    : nil
            )
        } catch {
            return AdminWaitlistPromotionOutcome(
                promotion: promotion,
                pushDelivered: false,
                warning: "The member is confirmed and their private notice is live, but Apple push delivery needs attention."
            )
        }
    }

    func adminProvisionProductPrice(session auth: AuthSession, product: AdminProduct) async throws -> AdminProduct {
        do {
            return try await vercelRequest(
                path: "/api/admin-commerce-health",
                body: AdminProductPriceProvisionRequest(
                    action: "provision_product_price",
                    confirmation: "CREATE STRIPE PRICE",
                    product_id: product.id,
                    expected_updated_at: product.updated_at
                ),
                auth: auth
            )
        } catch let error as APIError {
            throw friendlyProductError(error)
        }
    }

    @discardableResult
    func adminAddMemberNote(
        session auth: AuthSession,
        memberID: UUID,
        category: String,
        body: String
    ) async throws -> UUID {
        let normalizedCategory = category.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard ["general", "coaching", "follow_up", "billing"].contains(normalizedCategory) else {
            throw APIError(message: "Choose a valid staff note category.")
        }
        guard (3...1_000).contains(normalizedBody.count) else {
            throw APIError(message: "Add a staff note between 3 and 1,000 characters.")
        }
        return try await rpc(
            path: "admin_add_member_note",
            body: AdminMemberNoteRequest(
                p_user_id: memberID,
                p_category: normalizedCategory,
                p_body: normalizedBody
            ),
            auth: auth
        )
    }

    func updateProfile(
        session auth: AuthSession,
        profileID: UUID,
        fullName: String,
        phone: String
    ) async throws -> MemberProfile {
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/profiles",
            queryItems: [URLQueryItem(name: "id", value: "eq.\(profileID.uuidString)")]
        )
        request.httpMethod = "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(ProfileUpdate(
            full_name: fullName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            phone: phone.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            updated_at: ISO8601DateFormatter.standard.string(from: Date())
        ))

        let profiles: [MemberProfile] = try await decode(request)
        guard let profile = profiles.first else {
            throw APIError(message: "Could not save account details.")
        }
        return profile
    }

    func saveMemberOnboarding(
        session auth: AuthSession,
        request body: MemberOnboardingSaveRequest
    ) async throws -> MemberOnboardingState {
        try await rpc(
            path: "save_my_member_onboarding",
            body: body,
            auth: auth
        )
    }

    func bookings(session auth: AuthSession) async throws -> [BookingItem] {
        try await rpc(path: "my_bookings", body: EmptyBody(), auth: auth)
    }

    func privateSessionRequests(session auth: AuthSession) async throws -> [PrivateSessionStatusItem] {
        try await restRequest(
            path: "/rest/v1/private_session_requests",
            queryItems: [
                URLQueryItem(name: "select", value: "id,status,requested_session_type,preferred_day,preferred_time,training_goal,created_at"),
                URLQueryItem(name: "order", value: "created_at.desc")
            ],
            auth: auth
        )
    }

    func book(session auth: AuthSession, classSessionID: UUID) async throws {
        let _: UUID = try await rpc(
            path: "book_session",
            body: ["p_session_id": classSessionID.uuidString],
            auth: auth
        )
    }

    func joinWaitlist(session auth: AuthSession, classSessionID: UUID) async throws {
        let _: UUID = try await rpc(
            path: "join_session_waitlist",
            body: ["p_session_id": classSessionID.uuidString],
            auth: auth
        )
    }

    func cancelBooking(
        session auth: AuthSession,
        bookingID: UUID
    ) async throws -> MemberBookingCancellationReceipt {
        let rows: [MemberBookingCancellationReceipt] = try await rpc(
            path: "cancel_booking",
            body: ["p_booking_id": bookingID.uuidString],
            auth: auth
        )
        guard rows.count == 1, let receipt = rows.first,
              receipt.cancelled_booking_id == bookingID,
              ["requested", "confirmed", "waitlisted"].contains(receipt.previous_status),
              ["returned", "not_reserved", "late_cancellation", "expired", "reservation_unavailable"]
                .contains(receipt.credit_outcome),
              receipt.credit_refunded == (receipt.credit_outcome == "returned") else {
            throw APIError(
                message: "The booking changed without a verifiable cancellation receipt. Refresh your account before continuing."
            )
        }
        return receipt
    }

    func checkout(session auth: AuthSession, productSlug: String, attemptID: UUID) async throws -> CheckoutResponse {
        let response: CheckoutResponse = try await vercelRequest(
            path: "/api/checkout",
            body: [
                "product_slug": productSlug,
                "return_target": "ios",
                "checkout_attempt_id": attemptID.uuidString.lowercased()
            ],
            auth: auth
        )
        return response
    }

    func requestPrivateSession(_ requestBody: PrivateSessionRequest, auth: AuthSession? = nil) async throws {
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/private_session_requests"
        )
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        if let auth {
            request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(requestBody)
        try await perform(request)
    }

    func submitMemberInterest(_ body: MemberInterestSubmission) async throws {
        try await submitPublicInterest(table: NativeInterestKind.member.rawValue, body: body)
    }

    func submitTrainerInterest(_ body: TrainerInterestSubmission) async throws {
        try await submitPublicInterest(table: NativeInterestKind.trainer.rawValue, body: body)
    }

    func submitPartnerInterest(_ body: PartnerInterestSubmission) async throws {
        try await submitPublicInterest(table: NativeInterestKind.partner.rawValue, body: body)
    }

    private func submitPublicInterest<Body: Encodable>(table: String, body: Body) async throws {
        guard NativeInterestKind(rawValue: table) != nil else { throw APIError(message: "Unknown XERT interest form.") }
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/rest/v1/\(table)")
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(body)
        try await perform(request)
    }

    /// Goes through submit_class_signup, the same entry point the website uses.
    /// Writing straight at class_bookings skipped every check the RPC makes —
    /// the class's own booking mode, its capacity, whether it has already
    /// started — and surfaced PostgREST's raw unique-constraint text to the
    /// member when they signed up twice. anon no longer holds an insert policy
    /// on that table at all, so this is now the only way in.
    func requestClassInterest(_ requestBody: ClassInterestRequest) async throws -> ClassSignupReceipt {
        var request = try request(
            baseURL: AppConfig.supabaseURL,
            path: "/rest/v1/rpc/submit_class_signup"
        )
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(requestBody.signupPayload)
        do {
            let data = try await responseData(for: request)
            return (try? JSONDecoder().decode(ClassSignupReceipt.self, from: data)) ?? ClassSignupReceipt()
        } catch {
            throw APIError(message: ClassSignupMessage.friendly(error.localizedDescription))
        }
    }

    func deleteAccount(session auth: AuthSession) async throws {
        let response: DeleteAccountResponse = try await vercelRequest(
            path: "/api/delete-account",
            body: ["confirmation": "DELETE"],
            auth: auth
        )
        guard response.deleted else {
            throw APIError(message: "XERT could not confirm that your account was deleted.")
        }
    }

    func updatePushSubscription(session auth: AuthSession, token: DevicePushToken, enabled: Bool) async throws {
        let response: PushSubscriptionResponse = try await vercelRequest(
            path: "/api/push-subscription",
            body: PushSubscriptionRequest(
                action: enabled ? "register" : "unregister",
                device_token: token.value,
                environment: token.environment
            ),
            auth: auth
        )
        guard response.registered == enabled else {
            throw APIError(message: "XERT could not confirm your notification preference.")
        }
    }

    func adminWorkouts(session auth: AuthSession, limit: Int = 21) async throws -> [AdminWorkoutOfDay] {
        try await restRequest(
            path: "/rest/v1/workouts_of_the_day",
            queryItems: [
                URLQueryItem(name: "select", value: "workout_date,title,body,published_at,created_by,updated_at"),
                URLQueryItem(name: "order", value: "workout_date.desc"),
                URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100)))
            ],
            auth: auth
        )
    }

    func adminWorkout(session auth: AuthSession, dateKey: String) async throws -> AdminWorkoutOfDay? {
        guard AdminWorkoutOfDay.date(from: dateKey) != nil else {
            throw APIError(message: "Pick a valid workout date.")
        }
        let rows: [AdminWorkoutOfDay] = try await restRequest(
            path: "/rest/v1/workouts_of_the_day",
            queryItems: [
                URLQueryItem(name: "select", value: "workout_date,title,body,published_at,created_by,updated_at"),
                URLQueryItem(name: "workout_date", value: "eq.\(dateKey)"),
                URLQueryItem(name: "limit", value: "2")
            ],
            auth: auth
        )
        guard rows.count <= 1 else {
            throw APIError(message: "Workout data integrity check failed for \(dateKey).")
        }
        return rows.first
    }

    func adminSaveWorkout(
        session auth: AuthSession,
        draft: AdminWorkoutOfDayDraft
    ) async throws -> AdminWorkoutOfDay {
        try await adminUpsertWorkout(session: auth, draft: draft)
    }

    func adminUpsertWorkout(
        session auth: AuthSession,
        draft: AdminWorkoutOfDayDraft
    ) async throws -> AdminWorkoutOfDay {
        if let validation = draft.validationMessage { throw APIError(message: validation) }

        let existing = try await adminWorkout(session: auth, dateKey: draft.dateKey)
        guard existing?.updated_at == draft.sourceUpdatedAt else {
            throw APIError(message: "This workout changed elsewhere. Refresh the day and review the latest version before saving.")
        }

        let publishedAt: String?
        if draft.isPublished {
            publishedAt = existing?.published_at.map { ISO8601DateFormatter.standard.string(from: $0) }
                ?? ISO8601DateFormatter.standard.string(from: Date())
        } else {
            publishedAt = nil
        }

        let payload = AdminWorkoutUpsertPayload(
            workout_date: draft.dateKey,
            title: draft.normalizedTitle,
            body: draft.normalizedBody,
            published_at: publishedAt,
            created_by: existing?.created_by ?? auth.user?.id,
            last_changed_by: auth.user?.id
        )
        var request: URLRequest
        if let existing {
            request = try self.request(
                baseURL: AppConfig.supabaseURL,
                path: "/rest/v1/workouts_of_the_day",
                queryItems: [
                    URLQueryItem(name: "workout_date", value: "eq.\(draft.dateKey)"),
                    URLQueryItem(name: "updated_at", value: "eq.\(existing.updated_at)")
                ]
            )
            request.httpMethod = "PATCH"
        } else {
            // A plain insert intentionally fails on the unique workout_date
            // constraint if another owner creates this day concurrently.
            request = try self.request(
                baseURL: AppConfig.supabaseURL,
                path: "/rest/v1/workouts_of_the_day"
            )
            request.httpMethod = "POST"
        }
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(payload)

        let rows: [AdminWorkoutOfDay]
        do {
            rows = try await decode(request)
        } catch {
            throw APIError(
                message: "The workout save could not be confirmed. Refresh this day before trying again."
            )
        }
        guard rows.count == 1, let saved = rows.first else {
            throw APIError(
                message: "This workout changed elsewhere. Refresh the day and review the latest version before saving."
            )
        }
        return saved
    }

    func adminForms(session auth: AuthSession) async throws -> [AdminForm] {
        try await restRequest(
            path: "/rest/v1/xert_forms",
            queryItems: [
                URLQueryItem(name: "select", value: "id,title,description,form_type,slug,questions,is_active,show_progress_bar,thank_you_message,redirect_url,header_media_type,header_media_url,header_media_caption,collect_name,collect_name_required,collect_email,collect_email_required,collect_phone,collect_phone_required,one_response_per_email,notify_admin,tags,response_count,created_at,updated_at"),
                URLQueryItem(name: "archived_at", value: "is.null"),
                URLQueryItem(name: "order", value: "updated_at.desc"),
                URLQueryItem(name: "limit", value: "200")
            ],
            auth: auth
        )
    }

    func adminFormResponses(session auth: AuthSession, formID: UUID) async throws -> [AdminFormResponse] {
        let legacySelect = "id,form_id,answers,respondent_name,respondent_email,respondent_phone,status,completed_at,time_taken_seconds,source_url,created_at"
        return try await restRequest(
            path: "/rest/v1/xert_form_responses",
            queryItems: [
                URLQueryItem(name: "select", value: legacySelect),
                URLQueryItem(name: "form_id", value: "eq.\(formID.uuidString.lowercased())"),
                URLQueryItem(name: "archived_at", value: "is.null"),
                URLQueryItem(name: "order", value: "created_at.desc"),
                URLQueryItem(name: "limit", value: "2000")
            ],
            auth: auth
        )
    }

    func adminFormResponse(session auth: AuthSession, responseID: UUID) async throws -> AdminFormResponse {
        let legacySelect = "id,form_id,answers,respondent_name,respondent_email,respondent_phone,status,completed_at,time_taken_seconds,source_url,created_at"
        let baseItems = [
            URLQueryItem(name: "id", value: "eq.\(responseID.uuidString.lowercased())"),
            URLQueryItem(name: "archived_at", value: "is.null"),
            URLQueryItem(name: "limit", value: "1")
        ]

        let rows: [AdminFormResponse]
        do {
            rows = try await restRequest(
                path: "/rest/v1/xert_form_responses",
                queryItems: [URLQueryItem(name: "select", value: "\(legacySelect),form_snapshot")] + baseItems,
                auth: auth
            )
        } catch let error as APIError where
            error.statusCode == 400 && error.message.localizedCaseInsensitiveContains("form_snapshot") {
            // Keep the owner operational while the additive snapshot migration
            // reaches every environment. This fallback can be removed after the
            // deployment is confirmed everywhere.
            rows = try await restRequest(
                path: "/rest/v1/xert_form_responses",
                queryItems: [URLQueryItem(name: "select", value: legacySelect)] + baseItems,
                auth: auth
            )
        }
        guard rows.count == 1, let response = rows.first else {
            throw APIError(message: "This form response is no longer available. Return to the response list and refresh.")
        }
        return response
    }

    func adminSaveForm(session auth: AuthSession, form: AdminForm?, draft: AdminFormDraft) async throws -> AdminForm {
        if let validation = draft.validationMessage { throw APIError(message: validation) }
        let payload = AdminFormPayload(draft: draft)
        var queryItems: [URLQueryItem] = []
        if let form {
            queryItems = [
                URLQueryItem(name: "id", value: "eq.\(form.id.uuidString.lowercased())"),
                URLQueryItem(name: "updated_at", value: "eq.\(form.updated_at)")
            ]
        }
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/rest/v1/xert_forms", queryItems: queryItems)
        request.httpMethod = form == nil ? "POST" : "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(payload)
        let forms: [AdminForm] = try await decode(request)
        guard let saved = forms.first else {
            throw APIError(message: "This form changed elsewhere. Refresh and review the latest version.")
        }
        return saved
    }

    func adminArchiveForm(session auth: AuthSession, form: AdminForm) async throws {
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/rest/v1/xert_forms", queryItems: [
            URLQueryItem(name: "id", value: "eq.\(form.id.uuidString.lowercased())"),
            URLQueryItem(name: "updated_at", value: "eq.\(form.updated_at)")
        ])
        request.httpMethod = "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(AdminFormArchivePayload(is_active: false, archived_at: ISO8601DateFormatter.standard.string(from: Date())))
        try await perform(request)
    }

    func adminUpdateFormResponseStatus(session auth: AuthSession, responseID: UUID, status: String) async throws {
        guard ["new", "reviewed", "followed_up", "closed"].contains(status) else {
            throw APIError(message: "Choose a valid response status.")
        }
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/rest/v1/xert_form_responses", queryItems: [
            URLQueryItem(name: "id", value: "eq.\(responseID.uuidString.lowercased())")
        ])
        request.httpMethod = "PATCH"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONEncoder().encode(AdminFormResponseStatusPayload(status: status))
        try await perform(request)
    }

    private func authRequest<T: Decodable, Body: Encodable>(
        path: String,
        queryItems: [URLQueryItem] = [],
        body: Body
    ) async throws -> T {
        var request = try request(baseURL: AppConfig.supabaseURL, path: path, queryItems: queryItems)
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await decode(request)
    }

    private func restRequest<T: Decodable>(
        path: String,
        queryItems: [URLQueryItem],
        auth: AuthSession? = nil
    ) async throws -> T {
        var request = try request(baseURL: AppConfig.supabaseURL, path: path, queryItems: queryItems)
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let auth {
            request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        }
        return try await decode(request)
    }

    private func restCount(
        path: String,
        queryItems: [URLQueryItem],
        auth: AuthSession
    ) async throws -> Int {
        var request = try request(baseURL: AppConfig.supabaseURL, path: path, queryItems: queryItems)
        request.httpMethod = "HEAD"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("count=exact", forHTTPHeaderField: "Prefer")
        let (_, response) = try await validatedResponse(for: request)
        guard
            let contentRange = response.value(forHTTPHeaderField: "Content-Range"),
            let totalText = contentRange.split(separator: "/").last,
            let total = Int(totalText)
        else {
            throw APIError(message: "XERT could not verify the lead action count.")
        }
        return total
    }

    private func rpc<T: Decodable, Body: Encodable>(
        path: String,
        body: Body,
        auth: AuthSession? = nil
    ) async throws -> T {
        var request = try request(baseURL: AppConfig.supabaseURL, path: "/rest/v1/rpc/\(path)")
        request.httpMethod = "POST"
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let auth {
            request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONEncoder().encode(body)
        return try await decode(request)
    }

    private func vercelRequest<T: Decodable, Body: Encodable>(
        path: String,
        body: Body,
        auth: AuthSession
    ) async throws -> T {
        var request = try request(baseURL: AppConfig.vercelBaseURL, path: path)
        request.httpMethod = "POST"
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await decode(request)
    }

    private func vercelGet<T: Decodable>(
        path: String,
        queryItems: [URLQueryItem] = [],
        auth: AuthSession
    ) async throws -> T {
        var request = try request(baseURL: AppConfig.vercelBaseURL, path: path, queryItems: queryItems)
        request.setValue("Bearer \(auth.access_token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await decode(request)
    }

    private func request(
        baseURL: URL,
        path: String,
        queryItems: [URLQueryItem] = []
    ) throws -> URLRequest {
        guard AppConfig.isTrustedServiceBaseURL(baseURL) else {
            throw APIError(message: "XERT services are temporarily unavailable.")
        }
        var url = baseURL
        for component in path.split(separator: "/") {
            url.appendPathComponent(String(component))
        }

        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw APIError(message: "Could not create API request.")
        }
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else {
            throw APIError(message: "Invalid API URL.")
        }
        return URLRequest(url: url, timeoutInterval: AppConfig.apiRequestTimeout)
    }

    private func perform(_ request: URLRequest) async throws {
        _ = try await responseData(for: request)
    }

    private func decode<T: Decodable>(_ request: URLRequest) async throws -> T {
        try decoder.decode(T.self, from: try await responseData(for: request))
    }

    private func responseData(for request: URLRequest) async throws -> Data {
        try await validatedResponse(for: request).0
    }

    private func validatedResponse(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw APIError(message: NetworkFailureMessage.display(for: error.code))
        } catch is CancellationError {
            throw APIError(message: NetworkFailureMessage.display(for: .cancelled))
        } catch {
            throw APIError(message: "The network request could not be completed. Please try again.")
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "Invalid network response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 {
                NotificationCenter.default.post(name: .xertAPIUnauthorizedResponse, object: self)
            }
            let rawMessage = String(data: data, encoding: .utf8)
            let message = (try? decoder.decode(SupabaseErrorResponse.self, from: data))?.displayMessage
                ?? (rawMessage?.isEmpty == false ? rawMessage : nil)
                ?? "Request failed."
            throw APIError(message: message, statusCode: http.statusCode)
        }
        return (data, http)
    }
}

private struct EmptyBody: Encodable {}
private struct EmptyObject: Decodable {}
private struct AdminLimitRequest: Encodable { let p_limit: Int }
private struct AdminCohortDaysRequest: Encodable { let p_cohort_days: Int }
private struct AdminFormPayload: Encodable {
    let title: String
    let description: String
    let form_type: String
    let slug: String
    let questions: [AdminFormQuestion]
    let is_active: Bool
    let show_progress_bar: Bool
    let thank_you_message: String
    let redirect_url: String?
    let header_media_type: String?
    let header_media_url: String?
    let header_media_caption: String?
    let collect_name: Bool
    let collect_name_required: Bool
    let collect_email: Bool
    let collect_email_required: Bool
    let collect_phone: Bool
    let collect_phone_required: Bool
    let one_response_per_email: Bool
    let notify_admin: Bool
    let tags: [String]

    init(draft: AdminFormDraft) {
        title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        description = draft.description.trimmingCharacters(in: .whitespacesAndNewlines)
        form_type = draft.formType
        slug = draft.slug.lowercased()
        questions = draft.questions
        is_active = draft.isActive
        show_progress_bar = draft.showProgressBar
        thank_you_message = draft.thankYouMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        redirect_url = draft.redirectURL.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        header_media_type = draft.headerMediaType.nilIfEmpty
        header_media_url = draft.headerMediaURL.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        header_media_caption = draft.headerMediaCaption.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        collect_name = draft.collectName
        collect_name_required = draft.collectNameRequired
        collect_email = draft.collectEmail
        collect_email_required = draft.collectEmailRequired
        collect_phone = draft.collectPhone
        collect_phone_required = draft.collectPhoneRequired
        one_response_per_email = draft.oneResponsePerEmail
        notify_admin = draft.notifyAdmin
        tags = draft.tags
    }
}
private struct AdminFormArchivePayload: Encodable { let is_active: Bool; let archived_at: String }
private struct AdminFormResponseStatusPayload: Encodable { let status: String }
private struct AdminSessionRequest: Encodable { let p_session_id: UUID }
private struct AdminWaitlistPromotionRequest: Encodable {
    let p_session_id: UUID
    let p_expected_booking_id: UUID
    let p_request_id: UUID
}
private struct AdminBookingStatusRequest: Encodable {
    let p_booking_id: UUID
    let p_status: String
    let p_request_id: UUID
}
private struct AdminStaffBookingRequest: Encodable {
    let p_session_id: UUID
    let p_member_id: UUID
    let p_request_id: UUID
}
private struct AdminAttendanceRequest: Encodable {
    let p_session_id: UUID
    let p_attended_ids: [UUID]
    let p_no_show_ids: [UUID]
}
private struct AdminOrderRequest: Encodable { let order_id: UUID }
private struct AdminRefundRequest: Encodable {
    let order_id: UUID
    let reason: String
    let confirmation: String
}
private struct AdminClassPayload: Encodable {
    let class_type: String
    let title: String
    let description: String?
    let coach_name: String?
    let start_time: String
    let end_time: String?
    let duration_minutes: Int
    let capacity: Int
    let location_zone: String?
    let beginner_friendly: Bool
    let intensity_level: String
    let status: String
    let public_visible: Bool
    let booking_mode: String
    let notes: String?
}
private struct AdminClassUpdateRequest: Encodable {
    let p_session_id: UUID
    let p_session: AdminClassPayload
}
private struct AdminCancellationNoticeRequest: Encodable {
    let action: String
    let session_id: UUID
}
private struct AdminSmsSendRequest: Encodable {
    let action: String
    let message: String
    let recipients: [AdminSmsRecipientPayload]
}
private struct AdminSmsRecipientPayload: Encodable {
    let name: String
    let phone: String
}

private struct AdminTargetedNoticeRequest: Encodable {
    let action: String
    let announcement_id: UUID
}
private struct AdminTargetedNoticeResponse: Decodable {
    let push: AdminTargetedPushSummary?
}
private struct AdminTargetedPushSummary: Decodable {
    let configured: Bool
    let attempted: Int
    let delivered: Int
    let failed: Int
}
private struct AdminAvailabilityPayload: Encodable {
    let start_time: String
    let end_time: String
    let type: String
    let coach_name: String?
    let notes: String?
    let is_bookable: Bool
}
private struct AdminBlackoutPayload: Encodable {
    let start_time: String
    let end_time: String
    let affects: String
    let reason: String
    let notes: String?
}
private struct AdminWorkoutUpsertPayload: Encodable {
    let workout_date: String
    let title: String?
    let body: String
    let published_at: String?
    let created_by: UUID?
    let last_changed_by: UUID?

    private enum CodingKeys: String, CodingKey {
        case workout_date, title, body, published_at, created_by, last_changed_by
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(workout_date, forKey: .workout_date)
        try container.encode(body, forKey: .body)
        if let title { try container.encode(title, forKey: .title) }
        else { try container.encodeNil(forKey: .title) }
        if let published_at { try container.encode(published_at, forKey: .published_at) }
        else { try container.encodeNil(forKey: .published_at) }
        try container.encodeIfPresent(created_by, forKey: .created_by)
        try container.encodeIfPresent(last_changed_by, forKey: .last_changed_by)
    }
}
private struct AdminSiteContentInsertPayload: Encodable {
    let key: String
    let data: AdminSiteContentData
}
private struct AdminSiteContentUpdatePayload: Encodable { let data: AdminSiteContentData }
private struct AdminMemberPageRequest: Encodable {
    let p_search: String?
    let p_role: String
    let p_credit: String
    let p_limit: Int
    let p_offset: Int
    let p_user_id: UUID?
}
private struct AdminMemberNotesRequest: Encodable {
    let p_user_id: UUID
    let p_include_archived: Bool
}
private struct AdminMemberIDsRequest: Encodable { let p_user_ids: [UUID] }
private struct AdminMemberIDRequest: Encodable { let p_user_id: UUID }
private struct AdminMemberNoticeRequest: Encodable {
    let p_user_id: UUID
    let p_title: String
    let p_body: String
    let p_tone: String
    let p_cta_label: String?
    let p_cta_url: String?
    let p_expires_at: String
}
private struct AdminCreditGrantRequest: Encodable {
    let p_user_id: UUID
    let p_sessions: Int
    let p_validity_days: Int?
    let p_request_id: UUID
    let p_note: String
}
private struct AdminRoleRequest: Encodable { let p_user_id: UUID; let p_role: String }
private struct AdminNoteArchiveRequest: Encodable { let p_note_id: UUID; let p_archived: Bool }
private struct AdminLeadUpdateRequest: Encodable {
    let p_lead_type: String
    let p_lead_id: String
    let p_status: String
    let p_admin_notes: String
}
private struct AdminLeadBulkUpdateRequest: Encodable {
    let p_lead_type: String
    let p_lead_ids: [String]
    let p_status: String
}
private struct AdminFitboxProspectRequest: Encodable {
    let action: String
    let lead_id: String
}
private struct AdminMemberNoteRequest: Encodable {
    let p_user_id: UUID
    let p_category: String
    let p_body: String
}
private struct AdminSettingsUpdate: Encodable {
    let target_launch_date: String
    let countdown_enabled: Bool
    let bookings_enabled: Bool
    let payments_enabled: Bool
    let prices_coming_soon: Bool
    let fitbox_enabled: Bool
    let fitbox_booking_url: String?
    let announcement_banner_text: String?
    let announcement_banner_enabled: Bool
    let updated_at: String
}
private struct AdminEmergencyPauseUpdate: Encodable {
    let bookings_enabled: Bool
    let payments_enabled: Bool
    let updated_at: String
}
private struct AdminPaymentActivationSettings: Encodable {
    let target_launch_date: String
    let countdown_enabled: Bool
    let bookings_enabled: Bool
    let payments_enabled: Bool
    let fitbox_enabled: Bool
    let announcement_banner_text: String?
    let announcement_banner_enabled: Bool
}
private struct AdminPaymentActivationRequest: Encodable {
    let action: String
    let confirmation: String
    let settings_id: UUID
    let expected_updated_at: String
    let settings: AdminPaymentActivationSettings
}
private struct AdminStripeReviewResolutionRequest: Encodable {
    let action: String
    let confirmation: String
    let event_id: String
    let error_code: String
}
struct AdminStripeReviewResolutionResponse: Decodable, Hashable {
    let event_id: String
    let status: String
}
private struct AdminStripeRetryRequest: Encodable {
    let action: String
    let confirmation: String
    let event_id: String
}
private struct AdminOwnerPushSmokeTestRequest: Encodable {
    let action: String
}
struct AdminStripeRetryResponse: Decodable, Hashable {
    let event_id: String
    let status: String
    let duplicate: Bool
}
private struct AdminRequestUpdate: Encodable {
    let p_request_type: String
    let p_request_id: String
    let p_status: String?
    let p_admin_notes: String?
    let p_update_admin_notes: Bool
    // Confirming a request now takes a place in the room, so the database
    // refuses one that would oversell. This is the owner deciding to squeeze
    // someone in anyway.
    var p_allow_overbook: Bool = false
}
private struct AdminAnnouncementPayload: Encodable {
    let title: String
    let body: String
    let tone: String
    let expires_at: String?
    let cta_label: String?
    let cta_url: String?
}
private struct AdminAnnouncementCreatePayload: Encodable {
    let title: String
    let body: String
    let tone: String
    let expires_at: String?
    let cta_label: String?
    let cta_url: String?
    let created_by: UUID

    init(announcement: AdminAnnouncementPayload, created_by: UUID) {
        title = announcement.title
        body = announcement.body
        tone = announcement.tone
        expires_at = announcement.expires_at
        cta_label = announcement.cta_label
        cta_url = announcement.cta_url
        self.created_by = created_by
    }
}
private struct AdminAnnouncementPublishRequest: Encodable {
    let id: UUID?
    let request_id: UUID
    let announcement: AdminAnnouncementPayload
    let expected_updated_at: String?
}
private struct AdminAnnouncementArchiveRequest: Encodable {
    let p_announcement_id: UUID
    let p_archived: Bool
    let p_expected_updated_at: String
}
private struct AdminAnnouncementUnpublishPayload: Encodable {
    private enum CodingKeys: String, CodingKey { case published_at }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeNil(forKey: .published_at)
    }
}

private struct AdminRoleAuditRow: Decodable {
    let id: UUID; let target_user_id: UUID; let changed_by: UUID?; let previous_role: String; let new_role: String; let created_at: Date
    var entry: AdminAuditEntry { .init(id: "role:\(id)", category: "Access", title: "Member role changed", detail: "\(previous_role) to \(new_role) · \(target_user_id.uuidString.prefix(8))", createdAt: created_at, operatorID: changed_by, subjectID: target_user_id.uuidString.lowercased()) }
}
private struct AdminCreditAuditRow: Decodable {
    let id: UUID; let user_id: UUID?; let granted_by: UUID?; let sessions: Int; let note: String?; let created_at: Date
    var entry: AdminAuditEntry { .init(id: "credit:\(id)", category: "Credits", title: "\(sessions) credit\(sessions == 1 ? "" : "s") granted", detail: note ?? "Member \(user_id?.uuidString.prefix(8) ?? "removed")", createdAt: created_at, operatorID: granted_by, subjectID: user_id?.uuidString.lowercased()) }
}
private struct AdminRequestAuditRow: Decodable {
    let id: UUID; let request_id: String; let request_type: String; let changed_by: UUID?; let previous_status: String?; let new_status: String?; let subject_label: String?; let subject_email: String?; let created_at: Date
    var entry: AdminAuditEntry { .init(id: "request:\(id)", category: "Requests", title: "\(request_type == "class_booking" ? "Booking" : "PT") request updated", detail: "\(subject_label ?? subject_email ?? "Request") · \(previous_status ?? "new") to \(new_status ?? "updated")", createdAt: created_at, operatorID: changed_by, subjectID: request_id) }
}
private struct AdminNoticeAuditRow: Decodable {
    let id: UUID; let announcement_id: UUID; let announcement_title: String?; let action: String; let actor_id: UUID?; let created_at: Date
    var entry: AdminAuditEntry { .init(id: "notice:\(id)", category: "Notices", title: "Member notice \(action)", detail: announcement_title ?? "Member announcement", createdAt: created_at, operatorID: actor_id, subjectID: announcement_id.uuidString.lowercased()) }
}
private struct AdminLeadAuditRow: Decodable {
    let id: UUID; let lead_id: String; let lead_type: String; let changed_by: UUID?; let previous_status: String?; let new_status: String?; let subject_label: String?; let subject_email: String?; let created_at: Date
    var entry: AdminAuditEntry { .init(id: "lead:\(id)", category: "Leads", title: "\(lead_type.capitalized) lead updated", detail: "\(subject_label ?? subject_email ?? "Lead") · \(previous_status ?? "new") to \(new_status ?? "updated")", createdAt: created_at, operatorID: changed_by, subjectID: lead_id) }
}
private struct AdminResourceAuditRow: Decodable {
    let id: UUID; let resource_id: String; let resource_type: String; let action: String; let changed_by: UUID?; let subject_label: String?; let created_at: Date
    func entry(category: String) -> AdminAuditEntry { .init(id: "\(category.lowercased()):\(id)", category: category, title: "\(resource_type.replacingOccurrences(of: "_", with: " ").capitalized) \(action)", detail: subject_label ?? "Managed resource", createdAt: created_at, operatorID: changed_by, subjectID: resource_id) }
}
private struct AdminBookingAuditRow: Decodable {
    let id: UUID; let booking_id: UUID; let member_id: UUID?; let changed_by: UUID?; let action: String; let class_label: String?; let created_at: Date
    var entry: AdminAuditEntry { .init(id: "booking:\(id)", category: "Bookings", title: action.replacingOccurrences(of: "_", with: " ").capitalized, detail: class_label ?? "Class booking", createdAt: created_at, operatorID: changed_by, subjectID: member_id?.uuidString.lowercased() ?? booking_id.uuidString.lowercased()) }
}
private struct AdminOrderReconciliationAuditRow: Decodable {
    let id: UUID; let status: String; let amount_cents: Int; let currency: String; let reconciled_at: Date; let reconciled_by: UUID?
    var entry: AdminAuditEntry {
        .init(
            id: "reconciliation:\(id)",
            category: "Commerce",
            title: status == "failed" ? "Expired checkout closed" : "Stripe order reconciled",
            detail: "\(Self.amount(amount_cents, currency: currency)) · order \(id.uuidString.prefix(8))",
            createdAt: reconciled_at,
            operatorID: reconciled_by,
            subjectID: id.uuidString.lowercased()
        )
    }

    private static func amount(_ cents: Int, currency: String) -> String {
        (Double(cents) / 100).formatted(.currency(code: currency.uppercased()))
    }
}
private struct AdminRefundAuditRow: Decodable {
    let refund_id: String; let stripe_event_id: String; let order_id: UUID; let amount_cents: Int; let currency: String
    let credits_revoked: Int; let credits_consumed: Int; let bookings_cancelled: Int; let refunded_at: Date

    var entry: AdminAuditEntry {
        .init(
            id: "refund:\(refund_id)",
            category: "Commerce",
            title: "Stripe order refunded",
            detail: "\(Self.amount(amount_cents, currency: currency)) · \(credits_revoked) credits revoked · \(credits_consumed) already used · \(bookings_cancelled) bookings cancelled",
            createdAt: refunded_at,
            operatorID: operatorID,
            subjectID: order_id.uuidString.lowercased()
        )
    }

    private var operatorID: UUID? {
        let parts = stripe_event_id.split(separator: ":")
        guard parts.count >= 3, parts[0] == "admin" else { return nil }
        return UUID(uuidString: String(parts[1]))
    }

    private static func amount(_ cents: Int, currency: String) -> String {
        (Double(cents) / 100).formatted(.currency(code: currency.uppercased()))
    }
}
private struct AdminProductPayload: Encodable {
    let name: String
    let description: String?
    let price_cents: Int
    let currency: String
    let sessions_count: Int
    let validity_days: Int
    let stripe_price_id: String?
    let featured: Bool
    let active: Bool
    let sort_order: Int
}
private struct AdminProductCreatePayload: Encodable {
    let name: String
    let description: String?
    let price_cents: Int
    let currency: String
    let sessions_count: Int
    let validity_days: Int
    let stripe_price_id: String?
    let featured: Bool
    let active: Bool
    let sort_order: Int
}
private struct AdminProductCreateRequest: Encodable {
    let p_slug: String
    let p_product: AdminProductCreatePayload
}
private struct AdminProductActivationRequest: Encodable {
    let action: String
    let product_id: UUID
    let product: AdminProductPayload
    let expected_updated_at: String
}

private struct AdminProductPriceProvisionRequest: Encodable {
    let action: String
    let confirmation: String
    let product_id: UUID
    let expected_updated_at: String
}

private struct AdminProductRPCResult: Decodable {
    let product: AdminProduct

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let product = try? container.decode(AdminProduct.self) {
            self.product = product
            return
        }
        let products = try container.decode([AdminProduct].self)
        guard let product = products.first else {
            throw DecodingError.valueNotFound(
                AdminProduct.self,
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Product mutation returned no row.")
            )
        }
        self.product = product
    }
}
private struct AdminProductUpdateRequest: Encodable {
    let p_product_id: UUID
    let p_product: AdminProductPayload
    let p_expected_updated_at: String
}
private struct AdminEventPayload: Encodable {
    let name: String
    let category: String
    let event_date: String?
    let end_date: String?
    let location: String?
    let region: String?
    let url: String?
    let published: Bool
    let sort_order: Int
}
private struct AdminMutationID: Decodable { let id: UUID }
private struct AdminCoachPayload: Encodable {
    let name: String
    let role: String?
    let bio: String?
    let experience: String?
    let currently_training_for: String?
    let photo_url: String?
    let social_url: String?
    let category: String
    let sort_order: Int
    let published: Bool
}
private struct ProfileUpdate: Encodable {
    let full_name: String?
    let phone: String?
    let updated_at: String
}

private struct EventGoalMutation: Encodable {
    let user_id: UUID
    let event_id: UUID
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

private struct EmptyResponse: Decodable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        _ = container.decodeNil()
    }
}

private struct DeleteAccountResponse: Decodable {
    let deleted: Bool
}

private struct PushSubscriptionRequest: Encodable {
    let action: String
    let device_token: String
    let environment: String
}

private struct PushSubscriptionResponse: Decodable {
    let registered: Bool
}

private extension ISO8601DateFormatter {
    static let standard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
